/**
 * One availability check, end to end.
 *
 * Transport strategy (this is the "how do we read the site" decision):
 *
 *   1. Plain HTTPS GET of the official public search URL — cheapest for us and
 *      lightest for the site. Tried first.
 *   2. A real Chromium on the same URL — only if (1) came back unreadable,
 *      which is what happens when the results are rendered client side.
 *
 * In "auto" mode the working transport is remembered for the rest of the
 * process, and the cheap one is re-tried once an hour so we drop back to it as
 * soon as it works again.
 */
import { logger } from '../logger.js';
import { describeError, isNetworkError } from '../redact.js';
import { parseAvailability } from '../parser/availability.js';
import { pendingScreenshotPath, saveDebugSnapshot } from './debugDump.js';
import { BrowserUnavailableError, fetchViaBrowser } from './browser.js';
import { fetchViaHttp, HttpTransportError, userAgent } from './http.js';
import { isPathAllowed, loadRobots } from './robots.js';
import { buildBookingLink, buildSearchUrl, RESERVE_ORIGIN, resolveHotel } from './url.js';
import type {
  CheckOutcome,
  MonitorSettings,
  RoomObservation,
  RoomOffer,
  TransportKind,
  WatchCondition,
} from '../types.js';

export interface CheckResult {
  watchId: string;
  outcome: CheckOutcome;
  /** Rooms the page showed as bookable, before watch keyword filtering. */
  offers: RoomOffer[];
  /** Every classified room row, bookable or not. */
  rooms: RoomObservation[];
  reason: string;
  signals: string[];
  transport: TransportKind | 'none';
  url: string;
  httpStatus: number | null;
  durationMs: number;
  /** Directory of the debug snapshot, when one was written. */
  debugDir: string | null;
}

/** Global pacing so several watches never burst requests at the site. */
let lastRequestAt = 0;
let requestChain: Promise<void> = Promise.resolve();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Serialises outbound requests and keeps at least `minSpacingMs` between them.
 * Purely to protect the site: checks are never run concurrently.
 */
async function paced<T>(minSpacingMs: number, task: () => Promise<T>): Promise<T> {
  const result = requestChain.then(async () => {
    const waitMs = lastRequestAt + minSpacingMs - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();
    return task();
  });
  // The chain must survive a failed task, and must include the task itself so
  // two checks can never be in flight at the same time.
  requestChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** Remembers which transport currently works, in "auto" mode. */
const transportState = {
  preferred: 'http' as TransportKind,
  /** Epoch ms after which the cheap transport is worth another try. */
  retryHttpAt: 0,
};

/** Test helper / used by `capture` to force a transport. */
export function resetTransportState(): void {
  transportState.preferred = 'http';
  transportState.retryHttpAt = 0;
}

const HTTP_RETRY_INTERVAL_MS = 60 * 60 * 1000;

function transportOrder(settings: MonitorSettings): TransportKind[] {
  if (settings.transport === 'http') return ['http'];
  if (settings.transport === 'playwright') return ['playwright'];
  if (transportState.preferred === 'http' || Date.now() >= transportState.retryHttpAt) {
    return ['http', 'playwright'];
  }
  return ['playwright'];
}

interface AttemptOutcome {
  html: string | null;
  httpStatus: number | null;
  transport: TransportKind;
  /** Set when the transport itself failed. */
  failure: { outcome: CheckOutcome; reason: string } | null;
  durationMs: number;
}

async function attempt(
  transport: TransportKind,
  url: string,
  settings: MonitorSettings,
  screenshotPath?: string,
): Promise<AttemptOutcome> {
  const startedAt = Date.now();
  try {
    const page = await paced(settings.minRequestSpacingSeconds * 1000, () =>
      transport === 'http'
        ? fetchViaHttp(url)
        : fetchViaBrowser(url, screenshotPath ? { screenshotPath } : {}),
    );
    return {
      html: page.html,
      httpStatus: page.status,
      transport,
      failure: null,
      durationMs: page.durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    if (err instanceof HttpTransportError) {
      return {
        html: null,
        httpStatus: err.status,
        transport,
        failure: {
          // A 403/429 is the site telling us to stop, not a parsing question.
          outcome: err.accessRestricted ? 'captcha' : 'network_error',
          reason: err.message,
        },
        durationMs,
      };
    }
    if (err instanceof BrowserUnavailableError) {
      return {
        html: null,
        httpStatus: null,
        transport,
        failure: { outcome: 'parser_error', reason: err.message },
        durationMs,
      };
    }
    if (isNetworkError(err)) {
      return {
        html: null,
        httpStatus: null,
        transport,
        failure: { outcome: 'network_error', reason: describeError(err) },
        durationMs,
      };
    }
    return {
      html: null,
      httpStatus: null,
      transport,
      failure: { outcome: 'parser_error', reason: describeError(err) },
      durationMs,
    };
  }
}

/** Runs one check for one watch condition. Never throws. */
export async function checkWatch(
  watch: WatchCondition,
  settings: MonitorSettings,
): Promise<CheckResult> {
  const hotel = resolveHotel(watch);
  const url = buildSearchUrl(watch);
  const bookingLink = buildBookingLink(watch);
  const startedAt = Date.now();

  const base = {
    watchId: watch.id,
    url,
    offers: [] as RoomOffer[],
    rooms: [] as RoomObservation[],
    signals: [] as string[],
    debugDir: null as string | null,
  };

  // --- robots.txt ----------------------------------------------------------
  if (settings.respectRobotsTxt) {
    try {
      const robots = await loadRobots(RESERVE_ORIGIN, userAgent());
      const pathWithQuery = new URL(url).pathname + new URL(url).search;
      if (!isPathAllowed(robots, pathWithQuery)) {
        logger.warn('robots.txt disallows this search URL; skipping the check', {
          watch: watch.id,
        });
        return {
          ...base,
          outcome: 'blocked_by_robots',
          reason: 'robots.txt on the official site disallows this path',
          transport: 'none',
          httpStatus: null,
          durationMs: Date.now() - startedAt,
        };
      }
      // A declared Crawl-delay always wins over our configured spacing.
      if (robots.crawlDelaySeconds !== null) {
        const declared = robots.crawlDelaySeconds;
        if (declared > settings.minRequestSpacingSeconds) {
          logger.info('Honouring robots.txt Crawl-delay', { seconds: declared });
          settings = { ...settings, minRequestSpacingSeconds: declared };
        }
      }
    } catch (err) {
      logger.warn('robots.txt check failed; continuing', { error: describeError(err) });
    }
  }

  // --- fetch + parse -------------------------------------------------------
  let last: { outcome: CheckOutcome; reason: string; signals: string[] } | null = null;
  let lastHtml: string | null = null;
  let lastStatus: number | null = null;
  let lastTransport: TransportKind = 'http';

  for (const transport of transportOrder(settings)) {
    // Always capture a screenshot on browser attempts, into a scratch file. If
    // the check then fails we move that file into the snapshot instead of
    // fetching the page a second time just to photograph it.
    const result = await attempt(
      transport,
      url,
      settings,
      transport === 'playwright' ? pendingScreenshotPath() : undefined,
    );
    lastTransport = transport;
    lastStatus = result.httpStatus;
    lastHtml = result.html;

    if (result.failure) {
      last = { ...result.failure, signals: [`transport:${transport}`] };
      // A network error or an access block is not something a different
      // transport should paper over: stop and back off.
      if (result.failure.outcome !== 'parser_error') break;
      logger.info('Transport produced no readable page; trying the next one', {
        watch: watch.id,
        transport,
      });
      continue;
    }

    const parsed = parseAvailability(result.html ?? '', {
      hotelCode: hotel.code,
      hotelName: hotel.name,
      fallbackUrl: bookingLink,
    });
    last = { outcome: parsed.outcome, reason: parsed.reason, signals: parsed.signals };

    if (parsed.outcome === 'available' || parsed.outcome === 'unavailable') {
      if (settings.transport === 'auto') {
        transportState.preferred = transport;
        if (transport === 'playwright') {
          transportState.retryHttpAt = Date.now() + HTTP_RETRY_INTERVAL_MS;
        }
      }
      return {
        ...base,
        outcome: parsed.outcome,
        offers: parsed.offers,
        rooms: parsed.rooms,
        reason: parsed.reason,
        signals: [...parsed.signals, `transport:${transport}`],
        transport,
        httpStatus: result.httpStatus,
        durationMs: Date.now() - startedAt,
      };
    }

    if (parsed.outcome === 'captcha') break; // Never retry a bot-check with another transport.
    if (parsed.outcome === 'network_error') break; // Site asked us to come back later.
    // parser_error: fall through and let the next transport try.
    logger.info('Page was not understood; trying the next transport', {
      watch: watch.id,
      transport,
      reason: parsed.reason,
    });
  }

  const outcome = last?.outcome ?? 'parser_error';
  const reason = last?.reason ?? 'No transport produced a result';
  const signals = last?.signals ?? [];

  // --- debug snapshot ------------------------------------------------------
  let debugDir: string | null = null;
  if (settings.saveDebugOnParserError && (outcome === 'parser_error' || outcome === 'captcha')) {
    debugDir = saveDebugSnapshot({
      watchId: watch.id,
      url,
      html: lastHtml,
      reason,
      signals,
      transport: lastTransport,
      includePendingScreenshot: lastTransport === 'playwright',
      ...(lastStatus !== null ? { httpStatus: lastStatus } : {}),
    });
  }

  return {
    ...base,
    outcome,
    reason,
    signals,
    transport: lastTransport,
    httpStatus: lastStatus,
    durationMs: Date.now() - startedAt,
    debugDir,
  };
}
