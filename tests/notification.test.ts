/**
 * LINE message building and delivery, with the network stubbed out.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { LineNotifier } from '../src/notification/line.js';
import {
  availabilityMessage,
  captchaMessage,
  monitorBrokenMessage,
  recoveryMessage,
  staleMessage,
  testMessage,
  MAX_MESSAGE_LENGTH,
} from '../src/notification/messages.js';
import { makeOffer, makeWatch } from './helpers.js';

const FAKE_TOKEN = 'test-channel-access-token-value-1234567890';
const FAKE_USER = 'U0123456789abcdef0123456789abcdef';

describe('message building', () => {
  const watch = makeWatch({ checkIn: '2026-11-20', nights: 1, adults: 2 });
  const at = new Date('2026-09-10T12:34:00');

  it('includes every detail the user asked for', () => {
    const text = availabilityMessage(watch, [makeOffer()], at);

    assert.match(text, /🏰 ミラコスタ空室発見！/);
    assert.match(text, /東京ディズニーシー・ホテルミラコスタ/);
    assert.match(text, /2026\/11\/20/);
    assert.match(text, /1泊/);
    assert.match(text, /大人2名/);
    assert.match(text, /ハーバービュー/);
    assert.match(text, /¥128,000/);
    assert.match(text, /2026\/09\/10 12:34/);
  });

  it('links to the official public search page for exactly these dates', () => {
    const text = availabilityMessage(watch, [makeOffer()], at);
    assert.match(text, /https:\/\/reserve\.tokyodisneyresort\.jp\/hotel\/list\/\?/);
    assert.match(text, /useDate=20261120/);
    assert.match(text, /searchHotelCD=DHM/);
    assert.match(text, /adultNum=2/);
    // No session-scoped or expiring material in the link.
    assert.ok(!/jsessionid|sessionToken|token=/i.test(text));
  });

  it('mentions children only when there are any', () => {
    assert.ok(!availabilityMessage(watch, [makeOffer()], at).includes('子ども'));
    const family = makeWatch({ children: 2 });
    assert.match(availabilityMessage(family, [makeOffer()], at), /子ども2名/);
  });

  it('lists several rooms and summarises the overflow', () => {
    const offers = Array.from({ length: 8 }, (_, i) =>
      makeOffer({ roomKey: `R${i}`, roomName: `テストルーム${i}` }),
    );
    const text = availabilityMessage(watch, offers, at);
    assert.match(text, /テストルーム0/);
    assert.match(text, /他 3 件/);
  });

  it('stays inside the LINE length limit even with absurd input', () => {
    const offers = Array.from({ length: 50 }, (_, i) =>
      makeOffer({ roomKey: `R${i}`, roomName: 'あ'.repeat(300) }),
    );
    assert.ok(availabilityMessage(watch, offers, at).length <= MAX_MESSAGE_LENGTH);
  });

  it('states plainly that a CAPTCHA was not bypassed', () => {
    const text = captchaMessage('miracosta-2026-11-20');
    assert.match(text, /⚠️ ミラコスタ監視停止/);
    assert.match(text, /自動突破は行っていません/);
  });

  it('says the site changed rather than claiming the hotel is full', () => {
    const text = monitorBrokenMessage('miracosta-2026-11-20', 'unrecognised page');
    assert.match(text, /⚠️ ミラコスタ監視システム異常/);
    assert.match(text, /空室判定を安全に停止しました/);
    assert.ok(!text.includes('満室です'));
  });

  it('builds the stale and recovery messages', () => {
    assert.match(staleMessage(new Date('2026-09-10T12:00:00'), 30), /30分以上経過/);
    assert.match(staleMessage(null, 30), /まだ一度もありません/);
    assert.match(recoveryMessage(), /✅ ミラコスタ監視復旧/);
    assert.match(testMessage(), /LINE通知テスト成功/);
  });
});

describe('LineNotifier', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.LINE_CHANNEL_ACCESS_TOKEN = FAKE_TOKEN;
    process.env.LINE_USER_ID = FAKE_USER;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_USER_ID;
  });

  const noSleep = async (): Promise<void> => undefined;

  it('posts to the LINE push endpoint with the configured recipient', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await new LineNotifier({ sleep: noSleep }).send('hello');
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, 'https://api.line.me/v2/bot/message/push');

    const body = JSON.parse(String(calls[0]?.init.body)) as { to: string; messages: unknown[] };
    assert.equal(body.to, FAKE_USER);
    assert.deepEqual(body.messages, [{ type: 'text', text: 'hello' }]);
  });

  it('retries a 500 and succeeds on a later attempt', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return attempts < 3
        ? new Response('{}', { status: 500 })
        : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await new LineNotifier({ sleep: noSleep }).send('hi');
    assert.equal(result.ok, true);
    assert.equal(attempts, 3);
  });

  it('gives up after the retry budget and reports the failure as retryable', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: 'Too Many Requests' }), {
        status: 429,
      })) as unknown as typeof fetch;

    const result = await new LineNotifier({ sleep: noSleep, maxAttempts: 2 }).send('hi');
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error ?? '', /429/);
  });

  it('does not retry a bad token, and says so', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      return new Response(JSON.stringify({ message: 'Invalid access token' }), { status: 401 });
    }) as unknown as typeof fetch;

    const result = await new LineNotifier({ sleep: noSleep }).send('hi');
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.equal(attempts, 1);
  });

  it('survives a network outage and reports it as retryable', async () => {
    globalThis.fetch = (async () => {
      const err = new Error('fetch failed') as NodeJS.ErrnoException;
      err.code = 'ENOTFOUND';
      throw err;
    }) as unknown as typeof fetch;

    const result = await new LineNotifier({ sleep: noSleep, maxAttempts: 2 }).send('hi');
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
  });

  it('never puts the access token in the error it returns', async () => {
    globalThis.fetch = (async () => {
      throw new Error(`connect failed using token ${FAKE_TOKEN}`);
    }) as unknown as typeof fetch;

    const result = await new LineNotifier({ sleep: noSleep, maxAttempts: 1 }).send('hi');
    assert.equal(result.ok, false);
    assert.ok(!result.error?.includes(FAKE_TOKEN), 'the token leaked into the error message');
  });

  it('sends nothing at all in dry-run mode', async () => {
    const fetchMock = mock.fn(async () => new Response('{}', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const written: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const result = await new LineNotifier({ dryRun: true }).send('🏰 ミラコスタ空室発見');
      assert.equal(result.ok, true);
      assert.equal(fetchMock.mock.callCount(), 0);
      assert.match(written.join(''), /\[DRY RUN\]/);
      assert.match(written.join(''), /Would send LINE notification/);
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it('reports missing credentials as a permanent, non-retryable problem', async () => {
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_USER_ID;
    const result = await new LineNotifier({ sleep: noSleep }).send('hi');
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.error ?? '', /LINE_CHANNEL_ACCESS_TOKEN/);
  });
});
