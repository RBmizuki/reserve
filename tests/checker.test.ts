/**
 * Transport selection and, above all, diagnosability.
 *
 * The motivating bug: the browser fallback failed to start (Chromium had never
 * been downloaded), and its error overwrote the result of the HTTP attempt that
 * *had* fetched a page. The reported reason blamed the browser, and the debug
 * snapshot came out empty — so the page that could not be parsed, which is the
 * only thing worth looking at, was thrown away.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { checkWatch, resetTransportState } from '../src/checker/disney.js';
import { clearRobotsCache } from '../src/checker/robots.js';
import { PATHS } from '../src/config.js';
import { setConsoleEcho } from '../src/logger.js';
import { makeSettings, makeWatch } from './helpers.js';

/** A real response from the site that our parser cannot make sense of. */
const UNPARSEABLE_PAGE =
  '<!DOCTYPE html><html lang="ja"><head><title>予約</title></head>' +
  '<body><div id="app"></div><p>ページを読み込んでいます</p></body></html>';

const SOLD_OUT_PAGE =
  '<!DOCTYPE html><html lang="ja"><body>' +
  '<p>ご希望の条件に合うお部屋がございません。</p></body></html>';

describe('checkWatch', () => {
  let originalFetch: typeof fetch;
  let originalBrowsersPath: string | undefined;
  const createdDebugDirs: string[] = [];

  const stubSite = (body: string, status = 200): void => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /private/\n', { status: 200 });
      }
      return new Response(body, { status, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
  };

  beforeEach(() => {
    setConsoleEcho(false);
    originalFetch = globalThis.fetch;
    originalBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    // Point Playwright at nothing, reproducing "Chromium was never downloaded".
    // It fails immediately, so no real browser is ever started by these tests.
    process.env.PLAYWRIGHT_BROWSERS_PATH = '/nonexistent-browsers-for-tests';
    clearRobotsCache();
    resetTransportState();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = originalBrowsersPath;
    for (const dir of createdDebugDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    setConsoleEcho(true);
  });

  const settings = (overrides = {}) => makeSettings({ minRequestSpacingSeconds: 0, ...overrides });

  it('answers from plain HTTP without starting a browser at all', async () => {
    stubSite(SOLD_OUT_PAGE);
    const result = await checkWatch(makeWatch(), settings());
    assert.equal(result.outcome, 'unavailable');
    assert.equal(result.transport, 'http');
    assert.ok(!result.reason.includes('Chromium'));
  });

  describe('when the browser fallback cannot start', () => {
    it('reports the HTTP reason too, not only the browser error', async () => {
      stubSite(UNPARSEABLE_PAGE);
      const result = await checkWatch(makeWatch(), settings({ saveDebugOnParserError: false }));

      assert.equal(result.outcome, 'parser_error');
      // The actionable half: what the site actually returned.
      assert.match(result.reason, /http: /);
      assert.match(result.reason, /did not contain room rows/);
      // Still surfaced, but no longer hiding the above.
      assert.match(result.reason, /playwright: /);
      // The attempt that fetched a page is the one we attribute the result to.
      assert.equal(result.transport, 'http');
    });

    it('still refuses to call it sold out', async () => {
      stubSite(UNPARSEABLE_PAGE);
      const result = await checkWatch(makeWatch(), settings({ saveDebugOnParserError: false }));
      assert.notEqual(result.outcome, 'unavailable');
    });

    it('saves the page the HTTP attempt fetched, so it can be diagnosed', async () => {
      stubSite(UNPARSEABLE_PAGE);
      const result = await checkWatch(makeWatch(), settings());

      assert.ok(result.debugDir, 'a debug snapshot should have been written');
      createdDebugDirs.push(result.debugDir);
      assert.ok(result.debugDir.startsWith(PATHS.debug));

      const saved = path.join(result.debugDir, 'page.sanitized.html');
      assert.ok(fs.existsSync(saved), 'the fetched HTML must be saved, not discarded');
      const body = fs.readFileSync(saved, 'utf8');
      assert.match(body, /ページを読み込んでいます/);
    });
  });

  it('reports each step so the CLI can show what it is waiting on', async () => {
    stubSite(SOLD_OUT_PAGE);
    const steps: string[] = [];
    await checkWatch(makeWatch(), settings(), (step) => steps.push(step));
    assert.deepEqual(steps, [
      'checking robots.txt',
      'requesting the official search page',
      'reading the page',
    ]);
  });

  it('stops on a robots.txt disallow without contacting the search page', async () => {
    let searchRequests = 0;
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /hotel/\n', { status: 200 });
      }
      searchRequests += 1;
      return new Response(SOLD_OUT_PAGE, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await checkWatch(makeWatch(), settings());
    assert.equal(result.outcome, 'blocked_by_robots');
    assert.equal(searchRequests, 0, 'a disallowed path must never be requested');
  });

  it('treats an access-restriction status as a bot check and stops', async () => {
    stubSite('<html><body>denied</body></html>', 403);
    const result = await checkWatch(makeWatch(), settings({ saveDebugOnParserError: false }));
    assert.equal(result.outcome, 'captcha');
    assert.ok(!result.reason.includes('Chromium'), 'must not fall through to the browser');
  });
});
