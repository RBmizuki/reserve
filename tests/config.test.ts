/**
 * Configuration validation. A typo in watch.json must fail loudly at startup,
 * never silently produce a monitor that watches the wrong thing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, MIN_INTERVAL_MINUTES, parseConfig } from '../src/config.js';
import { buildSearchUrl, toUseDate } from '../src/checker/url.js';
import { findHotel } from '../src/checker/hotels.js';
import { makeWatch } from './helpers.js';

const VALID = {
  watches: [
    {
      id: 'miracosta-2026-11-20',
      hotel: 'miracosta',
      checkIn: '2026-11-20',
      nights: 1,
      adults: 2,
      children: 0,
      roomKeywords: ['ポルト・パラディーゾ・サイド', 'ハーバービュー'],
    },
    {
      id: 'miracosta-2026-11-21',
      hotel: 'miracosta',
      checkIn: '2026-11-21',
      nights: 1,
      adults: 2,
      children: 0,
      roomKeywords: [],
    },
  ],
};

describe('parseConfig', () => {
  it('accepts the documented example with two watches', () => {
    const config = parseConfig(VALID);
    assert.equal(config.watches.length, 2);
    assert.deepEqual(config.watches[1]?.roomKeywords, []);
    assert.equal(config.watches[0]?.enabled, true);
    assert.equal(config.watches[0]?.rooms, 1);
  });

  it('falls back to safe defaults when settings are omitted', () => {
    const config = parseConfig(VALID);
    assert.equal(config.settings.intervalMinutes, 10);
    assert.equal(config.settings.respectRobotsTxt, true);
    assert.equal(config.settings.notifyOnInitialAvailability, true);
    assert.equal(config.settings.transport, 'auto');
  });

  it('refuses an interval that would hammer the site', () => {
    assert.throws(
      () => parseConfig({ ...VALID, settings: { intervalMinutes: 1 } }),
      (err: unknown) => err instanceof ConfigError && /between 5/.test((err as Error).message),
    );
    // The documented floor is what the code enforces.
    assert.equal(MIN_INTERVAL_MINUTES, 5);
    assert.doesNotThrow(() => parseConfig({ ...VALID, settings: { intervalMinutes: 5 } }));
  });

  it('rejects duplicate watch ids', () => {
    const duplicated = { watches: [VALID.watches[0], VALID.watches[0]] };
    assert.throws(() => parseConfig(duplicated), /Duplicate watch id/);
  });

  it('rejects a malformed date', () => {
    const bad = { watches: [{ ...VALID.watches[0], checkIn: '2026/11/20' }] };
    assert.throws(() => parseConfig(bad), /YYYY-MM-DD/);
  });

  it('rejects an unknown hotel and lists the valid ones', () => {
    const bad = { watches: [{ ...VALID.watches[0], hotel: 'hilton' }] };
    assert.throws(() => parseConfig(bad), /miracosta/);
  });

  it('rejects an empty watch list', () => {
    assert.throws(() => parseConfig({ watches: [] }), /empty/);
    assert.throws(() => parseConfig({}), /watches/);
  });

  it('rejects out-of-range party sizes', () => {
    assert.throws(() => parseConfig({ watches: [{ ...VALID.watches[0], adults: 0 }] }), /adults/);
    assert.throws(() => parseConfig({ watches: [{ ...VALID.watches[0], nights: 99 }] }), /nights/);
  });
});

describe('official search URL', () => {
  it("uses the site's YYYYMMDD date parameter", () => {
    assert.equal(toUseDate('2026-11-20'), '20261120');
    assert.throws(() => toUseDate('20261120'), /YYYY-MM-DD/);
  });

  it('builds a public URL with no credentials in it', () => {
    const url = new URL(buildSearchUrl(makeWatch({ adults: 3, children: 1, nights: 2 })));
    assert.equal(url.origin, 'https://reserve.tokyodisneyresort.jp');
    assert.equal(url.pathname, '/hotel/list/');
    assert.equal(url.searchParams.get('searchHotelCD'), 'DHM');
    assert.equal(url.searchParams.get('useDate'), '20261120');
    assert.equal(url.searchParams.get('stayingDays'), '2');
    assert.equal(url.searchParams.get('adultNum'), '3');
    assert.equal(url.searchParams.get('childNum'), '1');
    // `removeSessionFlg` is one of the site's own form flags, so check for
    // credential-bearing parameter names specifically rather than substrings.
    for (const key of url.searchParams.keys()) {
      assert.ok(
        !/^(jsessionid|session|token|auth|sig|signature|sid)$/i.test(key),
        `unexpected credential-looking parameter: ${key}`,
      );
    }
  });

  it('knows MiraCosta by key and by official hotel code', () => {
    assert.equal(findHotel('miracosta')?.code, 'DHM');
    assert.equal(findHotel('DHM')?.key, 'miracosta');
    assert.equal(findHotel('nope'), undefined);
  });
});
