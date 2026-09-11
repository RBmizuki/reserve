/**
 * End-to-end behaviour of one check cycle, with the network stubbed.
 *
 * These cover the "do not spam LINE" and "fail safe" requirements that only
 * emerge once the parser, the state machine, the alert bookkeeping and the
 * notifier are wired together.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setConsoleEcho } from '../src/logger.js';
import { LineNotifier } from '../src/notification/line.js';
import { checkStaleness } from '../src/monitor.js';
import { runCheckCycle, SYSTEM_KEYS, type CycleDeps } from '../src/runCheck.js';
import { Storage } from '../src/storage/sqlite.js';
import type { CheckResult } from '../src/checker/disney.js';
import type { CheckOutcome, RoomObservation } from '../src/types.js';
import { makeOffer, makeSettings, makeWatch, observations } from './helpers.js';

const WATCH = makeWatch();
const BALCONY = makeOffer();

/** Captures what would have been sent, without touching the network. */
class RecordingNotifier extends LineNotifier {
  readonly sent: string[] = [];
  failNext = false;

  override async send(text: string): Promise<{ ok: boolean; error?: string; retryable?: boolean }> {
    if (this.failNext) return { ok: false, error: 'simulated LINE outage', retryable: true };
    this.sent.push(text);
    return { ok: true };
  }
}

function stubResult(outcome: CheckOutcome, rooms: RoomObservation[] = []): CheckResult {
  return {
    watchId: WATCH.id,
    outcome,
    offers: rooms.filter((r) => r.state === 'available').map((r) => r.offer),
    rooms,
    reason: `stubbed ${outcome}`,
    signals: [],
    transport: 'http',
    url: 'https://reserve.tokyodisneyresort.jp/hotel/list/?searchHotelCD=DHM',
    httpStatus: 200,
    durationMs: 12,
    debugDir: null,
  };
}

describe('runCheckCycle', () => {
  let storage: Storage;
  let notifier: RecordingNotifier;

  const deps = (outcomes: CheckResult[]): CycleDeps => {
    let i = 0;
    return {
      storage,
      notifier,
      settings: makeSettings({ parserErrorThreshold: 3 }),
      check: async () => outcomes[Math.min(i++, outcomes.length - 1)]!,
    };
  };

  beforeEach(() => {
    setConsoleEcho(false);
    storage = new Storage(':memory:');
    notifier = new RecordingNotifier();
  });
  afterEach(() => {
    storage.close();
    setConsoleEcho(true);
  });

  it('sends one availability message and records it in history', async () => {
    const d = deps([stubResult('available', observations([BALCONY, 'available']))]);
    const summary = await runCheckCycle(d, WATCH);

    assert.equal(summary.outcome, 'available');
    assert.equal(summary.watchState, 'available');
    assert.equal(summary.notificationsSent, 1);
    assert.equal(notifier.sent.length, 1);
    assert.match(notifier.sent[0] ?? '', /ミラコスタ空室発見/);

    const history = storage.recentChecks(10);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.outcome, 'available');
    assert.equal(history[0]?.notified, 1);
    assert.equal(storage.recentNotifications(10)[0]?.success, 1);
  });

  it('says nothing at all when the hotel is simply full', async () => {
    const d = deps([stubResult('unavailable', observations([BALCONY, 'unavailable']))]);
    const summary = await runCheckCycle(d, WATCH);
    assert.equal(summary.watchState, 'unavailable');
    assert.equal(notifier.sent.length, 0);
  });

  it('records lastSuccessfulCheck only for a conclusive result', async () => {
    await runCheckCycle(deps([stubResult('unavailable')]), WATCH);
    const first = storage.getSystemState(SYSTEM_KEYS.lastSuccessfulCheck);
    assert.ok(first);

    await runCheckCycle(deps([stubResult('network_error')]), WATCH);
    assert.equal(storage.getSystemState(SYSTEM_KEYS.lastSuccessfulCheck), first);
  });

  describe('CAPTCHA', () => {
    it('suspends the watch and warns once, without ever retrying past it', async () => {
      const d = deps([stubResult('captcha')]);
      const summary = await runCheckCycle(d, WATCH);

      assert.equal(summary.watchState, 'unknown');
      assert.equal(summary.nextDelayMs, null, 'a suspended watch must not be rescheduled');
      assert.equal(storage.getWatchRuntime(WATCH.id).suspendedReason, 'captcha');
      assert.equal(notifier.sent.length, 1);
      assert.match(notifier.sent[0] ?? '', /自動突破は行っていません/);
    });

    it('does not send the same warning again on the next check', async () => {
      await runCheckCycle(deps([stubResult('captcha')]), WATCH);
      await runCheckCycle(deps([stubResult('captcha')]), WATCH);
      await runCheckCycle(deps([stubResult('captcha')]), WATCH);
      assert.equal(
        notifier.sent.length,
        1,
        'the CAPTCHA warning must be sent once, not repeatedly',
      );
    });

    it('clears the warning once checks succeed again', async () => {
      await runCheckCycle(deps([stubResult('captcha')]), WATCH);
      await runCheckCycle(deps([stubResult('unavailable')]), WATCH);
      assert.equal(storage.isAlertActive('captcha', WATCH.id), false);
      assert.equal(storage.getWatchRuntime(WATCH.id).suspendedReason, null);
    });
  });

  describe('site structure change', () => {
    it('never reports unavailable, and warns once at the threshold', async () => {
      for (let i = 0; i < 5; i++) {
        const summary = await runCheckCycle(deps([stubResult('parser_error')]), WATCH);
        assert.equal(summary.watchState, 'unknown');
        assert.notEqual(summary.watchState, 'unavailable');
      }
      assert.equal(storage.getWatchRuntime(WATCH.id).monitorBroken, 1);
      assert.equal(notifier.sent.length, 1, 'MONITOR_BROKEN must be announced once');
      assert.match(notifier.sent[0] ?? '', /空室判定を安全に停止しました/);
    });

    it('stays quiet below the threshold', async () => {
      await runCheckCycle(deps([stubResult('parser_error')]), WATCH);
      await runCheckCycle(deps([stubResult('parser_error')]), WATCH);
      assert.equal(notifier.sent.length, 0);
      assert.equal(storage.getWatchRuntime(WATCH.id).monitorBroken, 0);
    });

    it('recovers automatically when the site becomes readable again', async () => {
      for (let i = 0; i < 3; i++) await runCheckCycle(deps([stubResult('parser_error')]), WATCH);
      assert.equal(storage.getWatchRuntime(WATCH.id).monitorBroken, 1);

      await runCheckCycle(deps([stubResult('unavailable')]), WATCH);
      assert.equal(storage.getWatchRuntime(WATCH.id).monitorBroken, 0);
      assert.equal(storage.isAlertActive('monitor_broken', WATCH.id), false);
    });
  });

  describe('errors and backoff', () => {
    it('backs off further on each consecutive failure, then resets on success', async () => {
      const delays: number[] = [];
      for (let i = 0; i < 4; i++) {
        const s = await runCheckCycle(deps([stubResult('network_error')]), WATCH);
        delays.push(s.nextDelayMs ?? 0);
      }
      // 5 -> 10 -> 20 -> 40 minutes
      assert.deepEqual(
        delays.map((d) => d / 60_000),
        [5, 10, 20, 40],
      );
      assert.equal(storage.getWatchRuntime(WATCH.id).consecutiveErrors, 4);

      const recovered = await runCheckCycle(deps([stubResult('unavailable')]), WATCH);
      assert.equal(storage.getWatchRuntime(WATCH.id).consecutiveErrors, 0);
      // Back to the normal 10-minute interval (plus/minus jitter).
      assert.ok((recovered.nextDelayMs ?? 0) > 8 * 60_000);
      assert.ok((recovered.nextDelayMs ?? 0) < 12 * 60_000);
    });

    it('keeps the availability notification pending when LINE is down', async () => {
      notifier.failNext = true;
      const rooms = observations([BALCONY, 'available']);
      const first = await runCheckCycle(deps([stubResult('available', rooms)]), WATCH);
      assert.equal(first.notificationsSent, 0);
      assert.equal(storage.getRoomState(WATCH.id, BALCONY.roomKey)?.notifyPending, 1);
      assert.equal(storage.recentNotifications(10)[0]?.success, 0);

      // LINE comes back: the alert is delivered on the next check.
      notifier.failNext = false;
      const second = await runCheckCycle(deps([stubResult('available', rooms)]), WATCH);
      assert.equal(second.notificationsSent, 1);
      assert.equal(notifier.sent.length, 1);
      assert.equal(storage.getRoomState(WATCH.id, BALCONY.roomKey)?.notifyPending, 0);
    });
  });

  describe('several watch conditions', () => {
    it('keeps runtime and notifications independent', async () => {
      const a = makeWatch({ id: 'miracosta-2026-11-20', checkIn: '2026-11-20' });
      const b = makeWatch({ id: 'miracosta-2026-11-21', checkIn: '2026-11-21' });

      await runCheckCycle(deps([stubResult('unavailable')]), a);
      await runCheckCycle(deps([stubResult('network_error')]), b);

      assert.equal(storage.getWatchRuntime(a.id).state, 'unavailable');
      assert.equal(storage.getWatchRuntime(a.id).consecutiveErrors, 0);
      assert.equal(storage.getWatchRuntime(b.id).state, 'unknown');
      assert.equal(storage.getWatchRuntime(b.id).consecutiveErrors, 1);
    });
  });
});

describe('stale monitoring alert', () => {
  let storage: Storage;
  let notifier: RecordingNotifier;

  beforeEach(() => {
    setConsoleEcho(false);
    storage = new Storage(':memory:');
    notifier = new RecordingNotifier();
  });
  afterEach(() => {
    storage.close();
    setConsoleEcho(true);
  });

  const deps = (): CycleDeps => ({
    storage,
    notifier,
    settings: makeSettings({ staleAfterMinutes: 30 }),
  });

  it('warns once when nothing has succeeded for too long', async () => {
    const old = new Date(Date.now() - 45 * 60_000).toISOString();
    storage.setSystemState(SYSTEM_KEYS.lastSuccessfulCheck, old);

    await checkStaleness(deps());
    await checkStaleness(deps());
    await checkStaleness(deps());

    assert.equal(notifier.sent.length, 1, 'the stale warning must be sent once, not every tick');
    assert.match(notifier.sent[0] ?? '', /30分以上経過/);
  });

  it('stays quiet while checks are recent', async () => {
    storage.setSystemState(SYSTEM_KEYS.lastSuccessfulCheck, new Date().toISOString());
    await checkStaleness(deps());
    assert.equal(notifier.sent.length, 0);
  });

  it('announces recovery once, then goes quiet again', async () => {
    storage.setSystemState(
      SYSTEM_KEYS.lastSuccessfulCheck,
      new Date(Date.now() - 45 * 60_000).toISOString(),
    );
    await checkStaleness(deps());
    assert.equal(notifier.sent.length, 1);

    storage.setSystemState(SYSTEM_KEYS.lastSuccessfulCheck, new Date().toISOString());
    await checkStaleness(deps());
    await checkStaleness(deps());
    assert.equal(notifier.sent.length, 2);
    assert.match(notifier.sent[1] ?? '', /監視復旧/);
  });

  it('does not fire on a fresh install that has never checked anything', async () => {
    storage.setSystemState(SYSTEM_KEYS.monitorStartedAt, new Date().toISOString());
    await checkStaleness(deps());
    assert.equal(notifier.sent.length, 0);
  });
});

/**
 * The official site publishes maintenance windows (roughly 02:00-07:00). A
 * monitor that reports "I cannot check" during a published outage is working
 * correctly, so it must not raise the "monitoring is blind" alarm overnight -
 * while still raising it if the outage stops looking routine.
 */
describe('official site maintenance', () => {
  let storage: Storage;
  let notifier: RecordingNotifier;

  beforeEach(() => {
    setConsoleEcho(false);
    storage = new Storage(':memory:');
    notifier = new RecordingNotifier();
  });
  afterEach(() => {
    storage.close();
    setConsoleEcho(true);
  });

  const deps = (result?: CheckResult): CycleDeps => ({
    storage,
    notifier,
    settings: makeSettings({ staleAfterMinutes: 30 }),
    ...(result ? { check: async () => result } : {}),
  });

  const maintenanceResult = (): CheckResult => ({
    ...stubResult('network_error'),
    reason: 'Site is holding visitors in a queue (混雑しております)',
    signals: ['busy:queue:混雑しております'],
  });

  it('records that the site, not the monitor, is down', async () => {
    await runCheckCycle(deps(maintenanceResult()), WATCH);
    assert.ok(storage.getSystemState(SYSTEM_KEYS.siteBusySince));
  });

  it('stays quiet overnight instead of waking you at 3am', async () => {
    await runCheckCycle(deps(maintenanceResult()), WATCH);
    storage.setSystemState(
      SYSTEM_KEYS.lastSuccessfulCheck,
      new Date(Date.now() - 45 * 60_000).toISOString(),
    );
    await checkStaleness(deps());
    assert.equal(notifier.sent.length, 0, 'a published outage is not a monitor failure');
  });

  it('does raise the alarm once the outage stops looking routine', async () => {
    await runCheckCycle(deps(maintenanceResult()), WATCH);
    // Pretend the "maintenance" has been going on for most of a day.
    storage.setSystemState(
      SYSTEM_KEYS.siteBusySince,
      new Date(Date.now() - 20 * 60 * 60_000).toISOString(),
    );
    storage.setSystemState(
      SYSTEM_KEYS.lastSuccessfulCheck,
      new Date(Date.now() - 20 * 60 * 60_000).toISOString(),
    );
    await checkStaleness(deps());
    assert.equal(notifier.sent.length, 1);
    assert.match(notifier.sent[0] ?? '', /監視異常/);
  });

  it('clears the maintenance flag as soon as a check succeeds', async () => {
    await runCheckCycle(deps(maintenanceResult()), WATCH);
    await runCheckCycle(deps(stubResult('unavailable')), WATCH);
    assert.equal(storage.getSystemState(SYSTEM_KEYS.siteBusySince), '');

    // ...so a later unrelated outage still alarms normally.
    storage.setSystemState(
      SYSTEM_KEYS.lastSuccessfulCheck,
      new Date(Date.now() - 45 * 60_000).toISOString(),
    );
    await checkStaleness(deps());
    assert.equal(notifier.sent.length, 1);
  });
});
