/**
 * The long-running monitor.
 *
 * Design notes that matter for 24/7 operation on a Mac:
 *
 *  - The loop ticks every 30 s and runs whichever watches are *due*. Each watch
 *    stores a single `nextCheckAt`, so if the Mac sleeps for six hours we come
 *    back and run one check per watch — never a burst of missed checks.
 *  - After a long gap we wait for the network to come back before checking, so
 *    a wake-from-sleep does not immediately count as a failure.
 *  - Nothing in here is allowed to throw out of the loop. Any unexpected error
 *    is logged and the loop continues; that is what keeps the process alive.
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { closeBrowser } from './checker/browser.js';
import { RESERVE_ORIGIN } from './checker/url.js';
import { enabledWatches, loadConfig, PATHS } from './config.js';
import { logger } from './logger.js';
import { LineNotifier } from './notification/line.js';
import { recoveryMessage, staleMessage } from './notification/messages.js';
import { describeError } from './redact.js';
import { runCheckCycle, SYSTEM_KEYS, type CycleDeps } from './runCheck.js';
import { openStorage, type Storage } from './storage/sqlite.js';

const TICK_MS = 30_000;
/**
 * How long the official site may report maintenance before we raise the alarm
 * anyway. Published maintenance runs a few minutes inside a 02:00-07:00 window,
 * so anything beyond a few hours is no longer routine and is worth knowing about.
 */
const MAINTENANCE_GRACE_MINUTES = 180;
/** A tick this much later than expected means the machine was asleep. */
const SLEEP_GAP_MS = TICK_MS * 4;
const LOCK_FILE = path.join(PATHS.data, 'monitor.lock');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- single instance --------------------------------------------------------

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses to start when another monitor is already running.
 * launchd also enforces one instance per label; this covers manual runs.
 */
function acquireLock(): void {
  fs.mkdirSync(PATHS.data, { recursive: true });
  if (fs.existsSync(LOCK_FILE)) {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && processAlive(pid)) {
      throw new Error(
        `Another monitor is already running (PID ${pid}).\n` +
          `Stop it first:  npm run stop-service    (or kill ${pid})`,
      );
    }
    logger.warn('Removing a stale lock file from a previous run', { stalePid: raw });
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
}

function releaseLock(): void {
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (Number.parseInt(raw, 10) === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    // Nothing to release.
  }
}

// --- network ----------------------------------------------------------------

/**
 * Waits until the official host resolves again.
 * Used after a suspected sleep/wake so we do not burn a backoff step on a
 * network stack that is still coming up.
 */
async function waitForNetwork(maxWaitMs = 5 * 60_000): Promise<boolean> {
  const host = new URL(RESERVE_ORIGIN).hostname;
  const deadline = Date.now() + maxWaitMs;
  let delay = 2_000;
  for (;;) {
    try {
      await dns.lookup(host);
      return true;
    } catch (err) {
      if (Date.now() >= deadline) {
        logger.warn('Network still unavailable after waiting', { error: describeError(err) });
        return false;
      }
      logger.info('Waiting for the network to come back', { retryInMs: delay });
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  }
}

// --- stale detection --------------------------------------------------------

/**
 * The most dangerous failure mode is "the process is running but nothing is
 * actually being checked". One warning is sent, and one recovery message.
 */
export async function checkStaleness(deps: CycleDeps): Promise<void> {
  const { storage, settings } = deps;
  const lastSuccessRaw = storage.getSystemState(SYSTEM_KEYS.lastSuccessfulCheck);
  const startedAtRaw = storage.getSystemState(SYSTEM_KEYS.monitorStartedAt);
  // Before the first ever success, measure from process start so a fresh
  // install does not fire the alarm immediately.
  const reference = lastSuccessRaw ?? startedAtRaw;
  if (!reference) return;

  const ageMs = Date.now() - new Date(reference).getTime();
  const stale = ageMs > settings.staleAfterMinutes * 60_000;

  if (stale) {
    // The site saying "we are down for maintenance" is a working monitor
    // reporting an outage, not a blind one. Stay quiet for a few hours.
    const maintenanceSince = storage.getSystemState(SYSTEM_KEYS.maintenanceSince);
    if (maintenanceSince) {
      const maintenanceMs = Date.now() - new Date(maintenanceSince).getTime();
      if (Number.isFinite(maintenanceMs) && maintenanceMs < MAINTENANCE_GRACE_MINUTES * 60_000) {
        logger.info('Holding the stale alert: the official site reports maintenance', {
          minutes: Math.round(maintenanceMs / 60_000),
        });
        return;
      }
    }
    if (storage.raiseAlert('stale', 'global', new Date().toISOString())) {
      logger.error('No successful check for too long', {
        minutes: Math.round(ageMs / 60_000),
      });
      const text = staleMessage(
        lastSuccessRaw ? new Date(lastSuccessRaw) : null,
        settings.staleAfterMinutes,
      );
      const result = await deps.notifier.send(text);
      storage.recordNotification({
        kind: 'stale',
        watchId: null,
        roomKey: null,
        summary: `No successful check for ${Math.round(ageMs / 60_000)} minutes`,
        sentAt: new Date().toISOString(),
        success: result.ok ? 1 : 0,
        error: result.ok ? null : (result.error ?? 'unknown'),
      });
    }
  } else if (storage.clearAlert('stale', 'global')) {
    logger.info('Checks are succeeding again');
    const result = await deps.notifier.send(recoveryMessage());
    storage.recordNotification({
      kind: 'recovery',
      watchId: null,
      roomKey: null,
      summary: 'Monitoring recovered',
      sentAt: new Date().toISOString(),
      success: result.ok ? 1 : 0,
      error: result.ok ? null : (result.error ?? 'unknown'),
    });
  }
}

// --- main loop --------------------------------------------------------------

export interface MonitorOptions {
  dryRun: boolean;
}

export async function runMonitor(options: MonitorOptions): Promise<number> {
  const config = loadConfig();
  const watches = enabledWatches(config);
  if (watches.length === 0) {
    logger.error('Every watch in config/watch.json is disabled — nothing to do');
    return 1;
  }

  acquireLock();

  const storage: Storage = openStorage();
  const deps: CycleDeps = {
    storage,
    notifier: new LineNotifier({ dryRun: options.dryRun }),
    settings: config.settings,
  };

  const startedAtIso = new Date().toISOString();
  storage.setSystemState(SYSTEM_KEYS.monitorPid, String(process.pid));
  storage.setSystemState(SYSTEM_KEYS.monitorStartedAt, startedAtIso);

  logger.info('monitor started', {
    pid: process.pid,
    watches: watches.length,
    intervalMinutes: config.settings.intervalMinutes,
    transport: config.settings.transport,
    dryRun: options.dryRun,
  });
  if (!options.dryRun && !LineNotifier.isConfigured()) {
    logger.warn('LINE is not configured — availability will be logged but not sent. See README.');
  }

  // A watch suspended by a CAPTCHA stays suspended until the service is
  // restarted; restarting is the documented way to resume, so clear it now.
  for (const watch of watches) {
    const runtime = storage.getWatchRuntime(watch.id);
    if (runtime.suspendedReason !== null) {
      logger.info('Resuming a previously suspended watch', {
        watch: watch.id,
        was: runtime.suspendedReason,
      });
      runtime.suspendedReason = null;
      runtime.nextCheckAt = null;
      storage.saveWatchRuntime(runtime);
    }
  }

  let stopping = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  const requestStop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received — finishing the current check and shutting down`);
  };
  process.on('SIGINT', () => requestStop('SIGINT'));
  process.on('SIGTERM', () => requestStop('SIGTERM'));
  // Never let an unexpected error kill the monitor.
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection (continuing)', { error: describeError(reason) });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception (continuing)', { error: describeError(err) });
  });

  let expectedTickAt = Date.now();

  try {
    while (!stopping) {
      const tickStart = Date.now();

      // --- sleep / wake detection ---
      const drift = tickStart - expectedTickAt;
      if (drift > SLEEP_GAP_MS) {
        logger.info('Woke up after a long gap (Mac sleep or suspended process)', {
          gapMinutes: Math.round(drift / 60_000),
        });
        await waitForNetwork();
        // Every watch is overdue now; each still runs exactly once below.
      }

      storage.setSystemState(SYSTEM_KEYS.lastHeartbeat, new Date().toISOString());

      for (const watch of watches) {
        if (stopping) break;
        const runtime = storage.getWatchRuntime(watch.id);
        if (runtime.suspendedReason !== null) continue;
        if (runtime.nextCheckAt && new Date(runtime.nextCheckAt).getTime() > Date.now()) continue;

        inFlight = runCheckCycle(deps, watch).catch((err: unknown) => {
          // A throw here would mean a bug; log it, back the watch off, carry on.
          logger.error('Unexpected error during a check (continuing)', {
            watch: watch.id,
            error: describeError(err),
          });
          const rt = storage.getWatchRuntime(watch.id);
          rt.consecutiveErrors += 1;
          rt.nextCheckAt = new Date(
            Date.now() + Math.min(config.settings.backoffMaxMinutes, 15) * 60_000,
          ).toISOString();
          storage.saveWatchRuntime(rt);
          return undefined;
        });
        await inFlight;
      }

      if (!stopping) {
        await checkStaleness(deps).catch((err: unknown) => {
          logger.warn('Staleness check failed', { error: describeError(err) });
        });
      }

      expectedTickAt = tickStart + TICK_MS;
      const waitMs = Math.max(0, expectedTickAt - Date.now());
      // Wake up promptly on Ctrl+C rather than sitting out the whole tick.
      const step = 500;
      for (let waited = 0; waited < waitMs && !stopping; waited += step) {
        await sleep(Math.min(step, waitMs - waited));
      }
    }
  } finally {
    logger.info('monitor stopping — closing resources');
    await inFlight.catch(() => undefined);
    await closeBrowser();
    storage.setSystemState(SYSTEM_KEYS.lastHeartbeat, new Date().toISOString());
    storage.close();
    releaseLock();
    logger.info('monitor stopped');
  }

  return 0;
}
