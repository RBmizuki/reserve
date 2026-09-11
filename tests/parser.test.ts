/**
 * Parser behaviour, driven entirely from fixtures — no network access.
 *
 * The most important assertions here are the negative ones: an unfamiliar page
 * must never be reported as "sold out".
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAvailability } from '../src/parser/availability.js';
import { fixture, PARSE_OPTIONS } from './helpers.js';

describe('parseAvailability', () => {
  it('detects available rooms and extracts the official room code, name and price', () => {
    const result = parseAvailability(fixture('available.html'), PARSE_OPTIONS);

    assert.equal(result.outcome, 'available');
    assert.equal(result.offers.length, 2);

    const codes = result.offers.map((o) => o.officialRoomCode).sort();
    assert.deepEqual(codes, ['HOTDHMPPT0002N', 'HOTDHMSPB0001N']);

    const balcony = result.offers.find((o) => o.officialRoomCode === 'HOTDHMSPB0001N');
    assert.ok(balcony);
    assert.match(balcony.roomName, /バルコニールーム/);
    assert.equal(balcony.side, 'ポルト・パラディーゾ・サイド');
    assert.equal(balcony.view, 'ハーバービュー');
    assert.equal(balcony.price, 128000);
    assert.equal(balcony.priceText, '¥128,000');
    // The room key prefers the official code over a derived hash.
    assert.equal(balcony.roomKey, 'HOTDHMSPB0001N');
  });

  it('reports the sold-out room on the same page as unavailable, not as an offer', () => {
    const result = parseAvailability(fixture('available.html'), PARSE_OPTIONS);
    const venezia = result.rooms.find((r) => r.offer.officialRoomCode === 'HOTDHMVEN0003N');
    assert.ok(venezia, 'the sold-out room should still be observed');
    assert.equal(venezia.state, 'unavailable');
    assert.ok(!result.offers.some((o) => o.officialRoomCode === 'HOTDHMVEN0003N'));
  });

  it('detects unavailable when every room row is marked sold out', () => {
    const result = parseAvailability(fixture('unavailable-rooms-marked.html'), PARSE_OPTIONS);
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.offers.length, 0);
    // All three rooms are recorded, so a later opening is a real transition.
    assert.equal(result.rooms.length, 3);
    assert.ok(result.rooms.every((r) => r.state === 'unavailable'));
  });

  it('detects unavailable from the "no matching rooms" message', () => {
    const result = parseAvailability(fixture('unavailable-message.html'), PARSE_OPTIONS);
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.offers.length, 0);
    assert.ok(result.signals.some((s) => s.startsWith('soldout:')));
  });

  it('treats a date outside the booking window as unavailable, with its own signal', () => {
    const result = parseAvailability(fixture('out-of-window.html'), PARSE_OPTIONS);
    assert.equal(result.outcome, 'unavailable');
    assert.ok(result.signals.some((s) => s.startsWith('window:')));
  });

  it('detects a CAPTCHA / access-restriction page', () => {
    const result = parseAvailability(fixture('captcha.html'), PARSE_OPTIONS);
    assert.equal(result.outcome, 'captcha');
    assert.equal(result.offers.length, 0);
  });

  it('treats a congestion page as a retryable error, not as sold out', () => {
    const result = parseAvailability(fixture('busy.html'), PARSE_OPTIONS);
    assert.equal(result.outcome, 'network_error');
    assert.notEqual(result.outcome, 'unavailable');
  });

  describe('never guesses "sold out"', () => {
    it('returns parser_error for a page it does not recognise', () => {
      const result = parseAvailability(fixture('parser-changed.html'), PARSE_OPTIONS);
      assert.equal(result.outcome, 'parser_error');
      assert.notEqual(result.outcome, 'unavailable');
    });

    it('returns parser_error when some room rows cannot be classified', () => {
      const result = parseAvailability(fixture('ambiguous-rooms.html'), PARSE_OPTIONS);
      assert.equal(result.outcome, 'parser_error');
      assert.notEqual(result.outcome, 'unavailable');
      assert.ok(result.reason.includes('could not be classified'));
    });

    it('returns parser_error for an empty body', () => {
      assert.equal(parseAvailability('', PARSE_OPTIONS).outcome, 'parser_error');
      assert.equal(parseAvailability('   ', PARSE_OPTIONS).outcome, 'parser_error');
    });

    it('returns parser_error for valid HTML with no reservation content at all', () => {
      const result = parseAvailability('<html><body><p>hello</p></body></html>', PARSE_OPTIONS);
      assert.equal(result.outcome, 'parser_error');
    });
  });

  it('never emits a URL that carries session material', () => {
    const result = parseAvailability(fixture('secrets-in-page.html'), PARSE_OPTIONS);
    for (const room of result.rooms) {
      assert.ok(!/sessionToken/i.test(room.offer.url ?? ''), 'session token leaked into a URL');
    }
  });
});

/**
 * Regression: a real check reported "Site is busy or under maintenance" at
 * 23:13, outside the official 2:00-7:00 maintenance window. The cause was that
 * maintenance wording was matched against the whole page before the room rows
 * were even looked at, so a notice banner about *future* downtime silently
 * disabled the monitor.
 */
describe('notices on a working page', () => {
  it('reads the rooms even when the page carries a maintenance notice', () => {
    const result = parseAvailability(
      fixture('available-with-maintenance-notice.html'),
      PARSE_OPTIONS,
    );
    assert.equal(result.outcome, 'available', 'a banner must not mask the search results');
    assert.equal(result.offers.length, 1);
    assert.equal(result.offers[0]?.officialRoomCode, 'HOTDHMSPB0001N');
  });

  it('still detects a genuine maintenance page, which lists no rooms', () => {
    const result = parseAvailability(fixture('maintenance.html'), PARSE_OPTIONS);
    assert.equal(result.outcome, 'network_error');
    assert.notEqual(result.outcome, 'unavailable');
  });

  it('trusts the official maintenance URL over anything in the body', () => {
    const result = parseAvailability(fixture('available.html'), {
      ...PARSE_OPTIONS,
      finalUrl: 'https://reserve.tokyodisneyresort.jp/online/error/maintenance/planning',
    });
    assert.equal(result.outcome, 'network_error');
    assert.match(result.reason, /maintenance page/);
  });

  it('only trusts access-restriction wording when no rooms are shown', () => {
    // The phrase appears, but the page is plainly a working results page.
    const page = fixture('available.html').replace(
      '<h1>',
      '<p><a href="/help">アクセスが制限されていますか？</a></p><h1>',
    );
    assert.equal(parseAvailability(page, PARSE_OPTIONS).outcome, 'available');

    // With no rooms, the same phrase is taken at face value.
    const blocked = '<html><body><h1>アクセスが制限されています</h1></body></html>';
    assert.equal(parseAvailability(blocked, PARSE_OPTIONS).outcome, 'captcha');
  });

  it('still treats bot-check machinery as decisive, rooms or not', () => {
    const page = fixture('available.html').replace(
      '<h1>',
      '<div class="g-recaptcha" data-sitekey="x"></div><h1>',
    );
    assert.equal(parseAvailability(page, PARSE_OPTIONS).outcome, 'captcha');
  });
});
