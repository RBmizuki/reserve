/**
 * One complete check cycle for one watch: fetch, classify, persist, notify.
 *
 * Shared by `npm run check` (one shot) and `npm run monitor` (forever), so the
 * two can never drift apart in behaviour.
 */
import { checkWatch, type CheckResult, type ProgressReporter } from './checker/disney.js';
import { logger } from './logger.js';
import { LineNotifier } from './notification/line.js';
import {
  availabilityMessage,
  captchaMessage,
  monitorBrokenMessage,
} from './notification/messages.js';
import { applyCheckResult, nextDelayMs } from './state/transitions.js';
import type { Storage } from './storage/sqlite.js';
import type { AvailabilityState, CheckOutcome, MonitorSettings, WatchCondition } from './types.js';

export const SYSTEM_KEYS = {
  lastHeartbeat: 'lastHeartbeat',
  lastCheck: 'lastCheck',
  lastSuccessfulCheck: 'lastSuccessfulCheck',
  monitorPid: 'monitorPid',
  monitorStartedAt: 'monitorStartedAt',
} as const;

export interface CycleDeps {
  storage: Storage;
  notifier: LineNotifier;
  settings: MonitorSettings;
  /**
   * How a page is fetched and classified. Defaults to the real checker;
   * the tests substitute a stub so they never touch the official site.
   */
  check?: (watch: WatchCondition, settings: MonitorSettings) => Promise<CheckResult>;
  /** Optional progress callback, used by `npm run check` to show a spinner. */
  onProgress?: ProgressReporter;
}

export interface CycleSummary {
  watchId: string;
  outcome: CheckOutcome;
  watchState: AvailabilityState;
  availableRooms: number;
  notificationsSent: number;
  reason: string;
  transport: string;
  durationMs: number;
  debugDir: string | null;
  /** Milliseconds until this watch should be checked again; null = suspended. */
  nextDelayMs: number | null;
}

/** Sends one message and records the attempt. Never throws. */
async function notify(
  deps: CycleDeps,
  kind: string,
  watchId: string | null,
  roomKey: string | null,
  summary: string,
  text: string,
): Promise<boolean> {
  logger.info('sending LINE notification', { kind, watch: watchId ?? '-' });
  const result = await deps.notifier.send(text);
  deps.storage.recordNotification({
    kind,
    watchId,
    roomKey,
    summary: summary.slice(0, 300),
    sentAt: new Date().toISOString(),
    success: result.ok ? 1 : 0,
    error: result.ok ? null : (result.error ?? 'unknown'),
  });
  if (!result.ok) {
    logger.error('LINE notification failed', {
      kind,
      watch: watchId ?? '-',
      error: result.error,
      retryable: result.retryable === true,
    });
  }
  return result.ok;
}

/**
 * Runs one check.
 *
 * @param dryRun When true the notifier prints instead of sending; state is
 *               still updated so the run is a faithful rehearsal.
 */
export async function runCheckCycle(deps: CycleDeps, watch: WatchCondition): Promise<CycleSummary> {
  const { storage, settings } = deps;
  const nowIso = new Date().toISOString();

  logger.info('check started', { watch: watch.id, date: watch.checkIn });
  storage.upsertWatchCondition(watch);
  storage.setSystemState(SYSTEM_KEYS.lastCheck, nowIso);

  const result = deps.check
    ? await deps.check(watch, settings)
    : await checkWatch(watch, settings, deps.onProgress);
  const runtime = storage.getWatchRuntime(watch.id);
  runtime.lastCheckAt = nowIso;

  const conclusive = result.outcome === 'available' || result.outcome === 'unavailable';
  const transition = applyCheckResult(storage, watch, settings, result, nowIso);

  let notificationsSent = 0;
  let suspended = false;

  if (conclusive) {
    runtime.state = transition.watchState;
    runtime.consecutiveErrors = 0;
    runtime.consecutiveParserErrors = 0;
    runtime.lastSuccessAt = nowIso;
    runtime.suspendedReason = null;
    storage.setSystemState(SYSTEM_KEYS.lastSuccessfulCheck, nowIso);

    // The site is readable again: retract any structural alerts.
    if (runtime.monitorBroken === 1) {
      runtime.monitorBroken = 0;
      storage.clearAlert('monitor_broken', watch.id);
      logger.info('parser recovered; availability judgement re-enabled', { watch: watch.id });
    }
    storage.clearAlert('captcha', watch.id);

    logger.info('result', {
      watch: watch.id,
      state: transition.watchState,
      rooms: transition.matchedAvailable,
      transport: result.transport,
      ms: result.durationMs,
    });

    for (const t of transition.transitions) {
      logger.info('room state change', {
        watch: watch.id,
        room: t.offer.roomKey,
        name: t.offer.roomName,
        from: t.from,
        to: t.to,
      });
    }

    if (transition.toNotify.length > 0) {
      const text = availabilityMessage(watch, transition.toNotify);
      const ok = await notify(
        deps,
        'availability',
        watch.id,
        transition.toNotify.map((o) => o.roomKey).join(','),
        `${transition.toNotify.length} room(s) available for ${watch.checkIn}`,
        text,
      );
      if (ok) {
        notificationsSent = transition.toNotify.length;
        // Clear the pending flag only now that LINE actually accepted it.
        for (const offer of transition.toNotify) {
          storage.markRoomNotified(watch.id, offer.roomKey, new Date().toISOString());
        }
      }
      // On failure the notify_pending flag stays set and the next check retries.
    }
  } else {
    runtime.state = 'unknown';
    runtime.consecutiveErrors += 1;

    if (result.outcome === 'captcha') {
      // Never attempt to get past a bot check: stop this watch and tell the user.
      suspended = true;
      runtime.suspendedReason = 'captcha';
      logger.warn('CAPTCHA or access restriction detected; suspending this watch', {
        watch: watch.id,
        reason: result.reason,
      });
      if (storage.raiseAlert('captcha', watch.id, nowIso)) {
        await notify(deps, 'captcha', watch.id, null, result.reason, captchaMessage(watch.id));
      }
    } else if (result.outcome === 'blocked_by_robots') {
      suspended = true;
      runtime.suspendedReason = 'robots';
      logger.warn('robots.txt disallows this URL; suspending this watch', { watch: watch.id });
      if (storage.raiseAlert('robots_blocked', watch.id, nowIso)) {
        await notify(
          deps,
          'robots_blocked',
          watch.id,
          null,
          result.reason,
          monitorBrokenMessage(watch.id, 'robots.txt がこのURLの取得を許可していません'),
        );
      }
    } else if (result.outcome === 'parser_error') {
      runtime.consecutiveParserErrors += 1;
      logger.warn('could not determine availability (treated as unknown, NOT sold out)', {
        watch: watch.id,
        reason: result.reason,
        consecutive: runtime.consecutiveParserErrors,
        debug: result.debugDir ?? '-',
      });
      if (
        runtime.consecutiveParserErrors >= settings.parserErrorThreshold &&
        runtime.monitorBroken === 0
      ) {
        runtime.monitorBroken = 1;
        logger.error('MONITOR_BROKEN: availability judgement suspended for this watch', {
          watch: watch.id,
        });
        if (storage.raiseAlert('monitor_broken', watch.id, nowIso)) {
          await notify(
            deps,
            'monitor_broken',
            watch.id,
            null,
            result.reason,
            monitorBrokenMessage(watch.id, result.reason),
          );
        }
      }
    } else {
      logger.warn('check failed', {
        watch: watch.id,
        outcome: result.outcome,
        reason: result.reason,
        consecutive: runtime.consecutiveErrors,
      });
    }
  }

  const delay = suspended ? null : nextDelayMs(runtime.consecutiveErrors, settings);
  runtime.nextCheckAt = delay === null ? null : new Date(Date.now() + delay).toISOString();
  storage.saveWatchRuntime(runtime);

  storage.recordCheck({
    watchId: watch.id,
    checkedAt: nowIso,
    outcome: result.outcome,
    reason: result.reason.slice(0, 500),
    transport: result.transport,
    httpStatus: result.httpStatus,
    durationMs: result.durationMs,
    availableRooms: transition.matchedAvailable,
    notified: notificationsSent > 0 ? 1 : 0,
  });

  if (!conclusive && delay !== null) {
    logger.info('backing off', { watch: watch.id, nextInMinutes: Math.round(delay / 60_000) });
  }

  return {
    watchId: watch.id,
    outcome: result.outcome,
    watchState: conclusive ? transition.watchState : 'unknown',
    availableRooms: transition.matchedAvailable,
    notificationsSent,
    reason: result.reason,
    transport: result.transport,
    durationMs: result.durationMs,
    debugDir: result.debugDir,
    nextDelayMs: delay,
  };
}
