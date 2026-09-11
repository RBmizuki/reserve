/**
 * Plain HTTPS transport.
 *
 * This is the preferred way to read the official search page: one ordinary GET
 * of a public URL, no browser, no JavaScript, minimal load on the site.
 */
import { logger } from '../logger.js';
import type { FetchedPage } from '../types.js';

/**
 * The User-Agent we send.
 *
 * We send the same string a normal Chrome on macOS sends, because that is
 * literally what the fallback transport (a real Chromium) sends and what the
 * user's own browser sends when they open the same public page. It is not an
 * attempt to defeat anything: we obey robots.txt, keep a conservative interval,
 * and stop entirely the moment the site shows a bot-check page.
 *
 * Override with USER_AGENT in .env if you prefer to identify differently.
 */
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

export function userAgent(): string {
  const override = (process.env.USER_AGENT ?? '').trim();
  return override.length > 0 ? override : DEFAULT_USER_AGENT;
}

/** Raised when the site answers with a status that means "not now". */
export class HttpTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True when the status suggests rate limiting or an access block. */
    readonly accessRestricted: boolean,
  ) {
    super(message);
    this.name = 'HttpTransportError';
  }
}

export interface HttpFetchOptions {
  timeoutMs?: number;
}

/** GETs a public URL and returns the body. Never sends or stores cookies. */
export async function fetchViaHttp(
  url: string,
  options: HttpFetchOptions = {},
): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const startedAt = Date.now();

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': userAgent(),
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    redirect: 'follow',
    // No credentials, ever: we only read public pages.
    credentials: 'omit',
    signal: AbortSignal.timeout(timeoutMs),
  });

  const durationMs = Date.now() - startedAt;

  if (response.status === 403 || response.status === 401 || response.status === 429) {
    throw new HttpTransportError(
      `Official site refused the request with HTTP ${response.status}`,
      response.status,
      true,
    );
  }
  if (response.status >= 500) {
    throw new HttpTransportError(
      `Official site returned HTTP ${response.status}`,
      response.status,
      false,
    );
  }
  if (!response.ok) {
    throw new HttpTransportError(
      `Unexpected HTTP ${response.status} from the official site`,
      response.status,
      false,
    );
  }

  const html = await response.text();
  logger.debug('http fetch complete', { status: response.status, bytes: html.length, durationMs });

  // response.url is the post-redirect address: landing on the maintenance page
  // is a much stronger signal than any phrase found in the body.
  return {
    url,
    finalUrl: response.url || url,
    status: response.status,
    html,
    transport: 'http',
    durationMs,
  };
}
