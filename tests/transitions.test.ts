/**
 * State-transition and de-duplication behaviour.
 *
 * This is the file to read to understand when a LINE message is sent.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  applyCheckResult,
  backoffMinutes,
  matchesWatch,
  nextDelayMs,
} from '../src/state/transitions.js';
import { Storage } from '../src/storage/sqlite.js';
import { makeOffer, makeSettings, makeWatch, observations } from './helpers.js';
import type { RoomObservation } from '../src/types.js';

const BALCONY = makeOffer();
const TERRACE = makeOffer({
  roomKey: 'HOTDHMPPT0002N',
  officialRoomCode: 'HOTDHMPPT0002N',
  roomName: 'ポルト・パラディーゾ・サイド テラスルーム ハーバービュー',
  price: 96400,
  priceText: '¥96,400',
});
const VENEZIA = makeOffer({
  roomKey: 'HOTDHMVEN0003N',
  officialRoomCode: 'HOTDHMVEN0003N',
  roomName: 'ヴェネツィア・サイド スーペリアルーム',
  side: 'ヴェネツィア・サイド',
  view: null,
  price: 72000,
  priceText: '¥72,000',
});

describe('applyCheckResult', () => {
  let storage: Storage;
  const watch = makeWatch();

  beforeEach(() => {
    storage = new Storage(':memory:');
  });

  /** Runs one conclusive check and returns how many rooms would be announced. */
  function check(rooms: RoomObservation[], settings = makeSettings()): string[] {
    const outcome = rooms.some((r) => r.state === 'available') ? 'available' : 'unavailable';
    const result = applyCheckResult(storage, watch, settings, { outcome, rooms });
    return result.toNotify.map((o) => o.roomKey);
  }

  /** Simulates LINE accepting the message, as runCheckCycle does on success. */
  function confirmDelivered(roomKeys: string[]): void {
    for (const key of roomKeys) storage.markRoomNotified(watch.id, key, new Date().toISOString());
  }

  describe('first ever sighting', () => {
    it('notifies when notifyOnInitialAvailability is true', () => {
      const notified = check(observations([BALCONY, 'available']));
      assert.deepEqual(notified, ['HOTDHMSPB0001N']);
    });

    it('stores state without notifying when notifyOnInitialAvailability is false', () => {
      const settings = makeSettings({ notifyOnInitialAvailability: false });
      const notified = check(observations([BALCONY, 'available']), settings);
      assert.deepEqual(notified, []);
      assert.equal(storage.getRoomState(watch.id, BALCONY.roomKey)?.state, 'available');
    });

    it('does not re-notify on the next check when the first was suppressed', () => {
      const settings = makeSettings({ notifyOnInitialAvailability: false });
      check(observations([BALCONY, 'available']), settings);
      assert.deepEqual(check(observations([BALCONY, 'available']), settings), []);
    });
  });

  describe('the core rule: notify only on a move into available', () => {
    it('unavailable -> available notifies', () => {
      check(observations([BALCONY, 'unavailable']));
      const notified = check(observations([BALCONY, 'available']));
      assert.deepEqual(notified, ['HOTDHMSPB0001N']);
    });

    it('available -> available does NOT notify again', () => {
      confirmDelivered(check(observations([BALCONY, 'available'])));
      assert.deepEqual(check(observations([BALCONY, 'available'])), []);
      assert.deepEqual(check(observations([BALCONY, 'available'])), []);
      assert.deepEqual(check(observations([BALCONY, 'available'])), []);
    });

    it('available -> unavailable only updates state', () => {
      confirmDelivered(check(observations([BALCONY, 'available'])));
      assert.deepEqual(check(observations([BALCONY, 'unavailable'])), []);
      assert.equal(storage.getRoomState(watch.id, BALCONY.roomKey)?.state, 'unavailable');
    });

    it('available -> unavailable -> available notifies a second time', () => {
      confirmDelivered(check(observations([BALCONY, 'available'])));
      check(observations([BALCONY, 'unavailable']));
      const notified = check(observations([BALCONY, 'available']));
      assert.deepEqual(notified, ['HOTDHMSPB0001N']);
    });

    it('walks the worked example from the brief', () => {
      // 12:00 unavailable, 12:05 unavailable, 12:10 available (notify),
      // 12:15-12:25 available (silent), 12:30-12:35 unavailable, 12:40 available (notify)
      const sent: string[][] = [];
      const record = (rooms: RoomObservation[]): void => {
        const notified = check(rooms);
        confirmDelivered(notified);
        sent.push(notified);
      };
      record(observations([BALCONY, 'unavailable'])); // 12:00
      record(observations([BALCONY, 'unavailable'])); // 12:05
      record(observations([BALCONY, 'available'])); //   12:10 <- notify
      record(observations([BALCONY, 'available'])); //   12:15
      record(observations([BALCONY, 'available'])); //   12:20
      record(observations([BALCONY, 'available'])); //   12:25
      record(observations([BALCONY, 'unavailable'])); // 12:30
      record(observations([BALCONY, 'unavailable'])); // 12:35
      record(observations([BALCONY, 'available'])); //   12:40 <- notify

      assert.deepEqual(
        sent.map((s) => s.length),
        [0, 0, 1, 0, 0, 0, 0, 0, 1],
      );
    });
  });

  describe('inconclusive checks', () => {
    for (const outcome of [
      'parser_error',
      'network_error',
      'captcha',
      'blocked_by_robots',
    ] as const) {
      it(`${outcome} leaves room state untouched and reports unknown`, () => {
        confirmDelivered(check(observations([BALCONY, 'available'])));

        const result = applyCheckResult(storage, watch, makeSettings(), { outcome, rooms: [] });
        assert.equal(result.watchState, 'unknown');
        assert.deepEqual(result.toNotify, []);
        // Crucially: still "available", NOT rewritten to unavailable.
        assert.equal(storage.getRoomState(watch.id, BALCONY.roomKey)?.state, 'available');
      });
    }

    it('does not produce a spurious notification after an outage', () => {
      confirmDelivered(check(observations([BALCONY, 'available'])));
      applyCheckResult(storage, watch, makeSettings(), { outcome: 'network_error', rooms: [] });
      applyCheckResult(storage, watch, makeSettings(), { outcome: 'parser_error', rooms: [] });
      // Site comes back, room still open: no duplicate alert.
      assert.deepEqual(check(observations([BALCONY, 'available'])), []);
    });

    it('unknown -> available notifies when the room was never confirmed sold out', () => {
      applyCheckResult(storage, watch, makeSettings(), { outcome: 'parser_error', rooms: [] });
      assert.deepEqual(check(observations([BALCONY, 'available'])), ['HOTDHMSPB0001N']);
    });
  });

  describe('failed LINE delivery', () => {
    it('retries on the next check instead of losing the notification', () => {
      // First check finds the room and wants to notify...
      assert.deepEqual(check(observations([BALCONY, 'available'])), ['HOTDHMSPB0001N']);
      // ...but LINE was down, so markRoomNotified is never called.
      assert.equal(storage.getRoomState(watch.id, BALCONY.roomKey)?.notifyPending, 1);

      // The next check still sees available -> available, yet must retry.
      assert.deepEqual(check(observations([BALCONY, 'available'])), ['HOTDHMSPB0001N']);

      // Once LINE accepts it, the retry stops.
      confirmDelivered(['HOTDHMSPB0001N']);
      assert.deepEqual(check(observations([BALCONY, 'available'])), []);
      assert.equal(storage.getRoomState(watch.id, BALCONY.roomKey)?.notifyPending, 0);
    });
  });

  describe('several rooms', () => {
    it('tracks each room independently', () => {
      confirmDelivered(check(observations([BALCONY, 'available'], [TERRACE, 'unavailable'])));

      // The terrace room opens; only it is announced.
      const notified = check(observations([BALCONY, 'available'], [TERRACE, 'available']));
      assert.deepEqual(notified, ['HOTDHMPPT0002N']);
      confirmDelivered(notified);

      // Both stay open: silence.
      assert.deepEqual(check(observations([BALCONY, 'available'], [TERRACE, 'available'])), []);
    });

    it('marks a room that disappears from the results as unavailable', () => {
      confirmDelivered(check(observations([BALCONY, 'available'], [TERRACE, 'available'])));
      check(observations([BALCONY, 'available']));
      assert.equal(storage.getRoomState(watch.id, TERRACE.roomKey)?.state, 'unavailable');
      // ...and re-announces it when it comes back.
      assert.deepEqual(check(observations([BALCONY, 'available'], [TERRACE, 'available'])), [
        'HOTDHMPPT0002N',
      ]);
    });

    it('announces several newly opened rooms in one go', () => {
      check(observations([BALCONY, 'unavailable'], [TERRACE, 'unavailable']));
      const notified = check(observations([BALCONY, 'available'], [TERRACE, 'available']));
      assert.equal(notified.length, 2);
    });
  });

  describe('room filtering', () => {
    it('ignores rooms that do not match every keyword', () => {
      const filtered = makeWatch({
        id: 'harbour-only',
        roomKeywords: ['ポルト・パラディーゾ・サイド', 'ハーバービュー'],
      });
      const result = applyCheckResult(storage, filtered, makeSettings(), {
        outcome: 'available',
        rooms: observations([BALCONY, 'available'], [VENEZIA, 'available']),
      });
      assert.deepEqual(
        result.toNotify.map((o) => o.roomKey),
        ['HOTDHMSPB0001N'],
      );
    });

    it('matches every room when roomKeywords is empty', () => {
      const result = applyCheckResult(storage, makeWatch(), makeSettings(), {
        outcome: 'available',
        rooms: observations([BALCONY, 'available'], [VENEZIA, 'available']),
      });
      assert.equal(result.toNotify.length, 2);
    });
  });

  describe('several watch conditions', () => {
    it('keeps state separate per watch', () => {
      const first = makeWatch({ id: 'miracosta-2026-11-20', checkIn: '2026-11-20' });
      const second = makeWatch({ id: 'miracosta-2026-11-21', checkIn: '2026-11-21' });
      const settings = makeSettings();
      const rooms = observations([BALCONY, 'available']);

      const a = applyCheckResult(storage, first, settings, { outcome: 'available', rooms });
      const b = applyCheckResult(storage, second, settings, { outcome: 'available', rooms });

      // The same room on two different dates is two separate notifications.
      assert.equal(a.toNotify.length, 1);
      assert.equal(b.toNotify.length, 1);
      assert.equal(storage.getRoomState(first.id, BALCONY.roomKey)?.state, 'available');
      assert.equal(storage.getRoomState(second.id, BALCONY.roomKey)?.state, 'available');
    });
  });

  describe('persistence', () => {
    it('survives reopening the database', () => {
      const file = `${process.env.TMPDIR ?? '/tmp'}/miracosta-test-${process.pid}-${Date.now()}.db`;
      const first = new Storage(file);
      applyCheckResult(storage, watch, makeSettings(), { outcome: 'available', rooms: [] });
      applyCheckResult(first, watch, makeSettings(), {
        outcome: 'available',
        rooms: observations([BALCONY, 'available']),
      });
      first.markRoomNotified(watch.id, BALCONY.roomKey, new Date().toISOString());
      first.close();

      const reopened = new Storage(file);
      const row = reopened.getRoomState(watch.id, BALCONY.roomKey);
      assert.equal(row?.state, 'available');
      assert.equal(row?.notifyPending, 0);
      // A restart must not re-announce a room it already announced.
      const again = applyCheckResult(reopened, watch, makeSettings(), {
        outcome: 'available',
        rooms: observations([BALCONY, 'available']),
      });
      assert.deepEqual(again.toNotify, []);
      reopened.close();
    });
  });
});

describe('matchesWatch', () => {
  it('AND-s all keywords', () => {
    const watch = makeWatch({ roomKeywords: ['ポルト・パラディーゾ・サイド', 'ハーバービュー'] });
    assert.equal(matchesWatch(BALCONY, watch), true);
    assert.equal(matchesWatch(VENEZIA, watch), false);
  });

  it('matches everything with no keywords', () => {
    const watch = makeWatch({ roomKeywords: [] });
    assert.equal(matchesWatch(VENEZIA, watch), true);
  });

  it('is insensitive to full-width / half-width differences', () => {
    const watch = makeWatch({ roomKeywords: ['ﾊｰﾊﾞｰﾋﾞｭｰ'] });
    assert.equal(matchesWatch(BALCONY, watch), true);
  });
});

describe('exponential backoff', () => {
  const settings = makeSettings({
    intervalMinutes: 5,
    backoffBaseMinutes: 5,
    backoffMaxMinutes: 60,
  });

  it('doubles on each consecutive failure', () => {
    assert.equal(backoffMinutes(1, settings), 5);
    assert.equal(backoffMinutes(2, settings), 10);
    assert.equal(backoffMinutes(3, settings), 20);
    assert.equal(backoffMinutes(4, settings), 40);
  });

  it('never exceeds the configured maximum', () => {
    assert.equal(backoffMinutes(5, settings), 60);
    assert.equal(backoffMinutes(20, settings), 60);
    assert.equal(backoffMinutes(1000, settings), 60);
  });

  it('returns to the normal interval once a check succeeds', () => {
    assert.equal(
      nextDelayMs(0, settings, () => 0.5),
      5 * 60_000,
    );
  });

  it('applies jitter only on success, and keeps it inside the configured band', () => {
    const jittered = makeSettings({ intervalMinutes: 10, jitterPercent: 20 });
    assert.equal(
      nextDelayMs(0, jittered, () => 0),
      8 * 60_000,
    ); // -20%
    assert.equal(
      nextDelayMs(0, jittered, () => 1),
      12 * 60_000,
    ); // +20%
    // Backoff is deterministic: no jitter while failing.
    assert.equal(
      nextDelayMs(2, jittered, () => 0),
      backoffMinutes(2, jittered) * 60_000,
    );
  });
});
