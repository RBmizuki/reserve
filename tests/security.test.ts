/**
 * Nothing secret may reach a log file, a debug dump, or an error message.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { describeError, isNetworkError, redact } from '../src/redact.js';
import { sanitizeHtml } from '../src/parser/sanitize.js';
import { fixture } from './helpers.js';

const TOKEN =
  'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6QUJDREVGR0hJSktMTU5PUA==';
const USER_ID = 'U0123456789abcdef0123456789abcdef';

describe('redact', () => {
  beforeEach(() => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = TOKEN;
    process.env.LINE_USER_ID = USER_ID;
  });
  afterEach(() => {
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_USER_ID;
  });

  it('removes the live channel access token wherever it appears', () => {
    const out = redact(`sending with token ${TOKEN} now`);
    assert.ok(!out.includes(TOKEN));
    assert.match(out, /REDACTED/);
  });

  it('removes the LINE user id', () => {
    assert.ok(!redact(`push to ${USER_ID}`).includes(USER_ID));
  });

  it('removes Authorization headers, bearer tokens and cookies', () => {
    assert.ok(!redact('Authorization: Bearer abc.def.ghi').includes('abc.def.ghi'));
    assert.ok(!redact('Cookie: JSESSIONID=1234567890abcdef').includes('1234567890abcdef'));
    assert.ok(!redact('set-cookie: a=b; Path=/').includes('a=b'));
  });

  it('removes JWTs and key=value secrets even when they are not ours', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36P';
    assert.ok(!redact(`token ${jwt}`).includes(jwt));
    assert.ok(!redact('password=hunter2').includes('hunter2'));
    assert.ok(!redact('"apiKey": "abc123xyz"').includes('abc123xyz'));
  });

  it('leaves ordinary Japanese page text alone', () => {
    const text = 'ポルト・パラディーゾ・サイド ハーバービュー ¥128,000';
    assert.equal(redact(text), text);
  });
});

describe('describeError', () => {
  beforeEach(() => {
    process.env.LINE_CHANNEL_ACCESS_TOKEN = TOKEN;
  });
  afterEach(() => {
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  });

  it('produces one safe line and never dumps the whole error object', () => {
    const err = new Error(`boom with ${TOKEN}`) as Error & { cause?: unknown };
    err.cause = { headers: { authorization: `Bearer ${TOKEN}` } };
    const described = describeError(err);
    assert.ok(!described.includes(TOKEN));
    assert.ok(!described.includes('authorization'));
    assert.ok(!described.includes('\n'));
  });

  it('handles non-Error throwables without crashing', () => {
    assert.match(describeError({ weird: true }), /Non-Error thrown/);
    assert.equal(describeError('plain string'), 'plain string');
  });

  it('includes the errno code, which is what makes logs diagnosable', () => {
    const err = new Error('getaddrinfo failed') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    assert.match(describeError(err), /ENOTFOUND/);
  });
});

describe('isNetworkError', () => {
  it('recognises the transient failures a laptop actually hits', () => {
    for (const code of ['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH']) {
      const err = new Error('nope') as NodeJS.ErrnoException;
      err.code = code;
      assert.equal(isNetworkError(err), true, code);
    }
    assert.equal(isNetworkError(new Error('fetch failed')), true);
    const abort = new Error('aborted');
    abort.name = 'TimeoutError';
    assert.equal(isNetworkError(abort), true);
  });

  it('does not classify a programming mistake as a network blip', () => {
    assert.equal(isNetworkError(new TypeError('x is not a function')), false);
    assert.equal(isNetworkError('string'), false);
  });
});

describe('sanitizeHtml (what may be written to debug/)', () => {
  const dirty = fixture('secrets-in-page.html');
  const clean = sanitizeHtml(dirty);

  it('strips scripts and styles entirely', () => {
    assert.ok(!clean.includes('s3cr3t-session-value'));
    assert.ok(!/<script/i.test(clean));
    assert.ok(!/<style/i.test(clean));
  });

  it('removes session ids, CSRF tokens and inline event handlers', () => {
    assert.ok(!clean.includes('ABCDEF0123456789'));
    assert.ok(!clean.includes('abc123secretcsrfvalue'));
    assert.ok(!/onload=/i.test(clean));
  });

  it('removes anything typed into a form, including personal data', () => {
    assert.ok(!clean.includes('村田みずき'));
    assert.ok(!clean.includes('hunter2'));
    assert.ok(!clean.includes('personal note'));
  });

  it('removes credentials embedded in links and in body text', () => {
    assert.ok(!clean.includes('leakme'));
    assert.ok(!/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\./.test(clean));
  });

  it('keeps the structure that makes a dump useful for debugging', () => {
    assert.ok(clean.includes('hotelRoomCd=HOTDHMSPB0001N'));
    assert.ok(clean.includes('部屋'));
  });

  it('caps the size of what it writes', () => {
    const huge = `<html><body>${'<p>x</p>'.repeat(200_000)}</body></html>`;
    assert.ok(sanitizeHtml(huge).length <= 512 * 1024 + 100);
  });
});
