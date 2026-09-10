/**
 * Playwright transport (fallback only).
 *
 * Used when the plain HTTP request cannot produce a readable page — typically
 * because the results are rendered client side. It drives a real Chromium to
 * the same public URL the HTTP transport uses. Nothing is bypassed: no stealth
 * plugins, no fingerprint spoofing, no CAPTCHA solving.
 *
 * The browser instance is reused across checks and lazily restarted, so a
 * 24/7 monitor does not pay the launch cost every cycle.
 */
import { logger } from '../logger.js';
import { describeError } from '../redact.js';
import { userAgent } from './http.js';
import type { FetchedPage } from '../types.js';

// Imported lazily so that `npm run test` and `npm run check --dry-run` work on a
// machine where the Chromium binary has not been downloaded yet.
type PlaywrightModule = typeof import('playwright');
type Browser = import('playwright').Browser;

let playwrightModule: PlaywrightModule | null = null;
let browser: Browser | null = null;

export class BrowserUnavailableError extends Error {}

async function getPlaywright(): Promise<PlaywrightModule> {
  if (playwrightModule) return playwrightModule;
  try {
    playwrightModule = await import('playwright');
    return playwrightModule;
  } catch (err) {
    throw new BrowserUnavailableError(
      `Playwright is not installed: ${describeError(err)}. Run: npm install`,
    );
  }
}

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  const { chromium } = await getPlaywright();
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage'],
    });
  } catch (err) {
    throw new BrowserUnavailableError(
      `Could not start Chromium: ${describeError(err)}. ` +
        `Install the browser once with: npx playwright install chromium`,
    );
  }
  logger.info('Chromium started for the browser transport');
  return browser;
}

/** Closes the shared browser. Called on shutdown. */
export async function closeBrowser(): Promise<void> {
  if (!browser) return;
  try {
    await browser.close();
  } catch (err) {
    logger.debug('Ignoring error while closing Chromium', { error: describeError(err) });
  } finally {
    browser = null;
  }
}

export interface BrowserFetchOptions {
  timeoutMs?: number;
  /** When set, a PNG screenshot of the final page is written here. */
  screenshotPath?: string;
}

/** Navigates a real browser to a public URL and returns the rendered HTML. */
export async function fetchViaBrowser(
  url: string,
  options: BrowserFetchOptions = {},
): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const startedAt = Date.now();
  const instance = await getBrowser();

  const context = await instance.newContext({
    userAgent: userAgent(),
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1280, height: 900 },
    // A fresh context every check: no cookies or session state are persisted.
    javaScriptEnabled: true,
  });

  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Give client-side rendering a chance to settle, but never hang on it:
    // some pages keep long-polling and `networkidle` would time out.
    await page
      .waitForLoadState('networkidle', { timeout: Math.min(15_000, timeoutMs) })
      .catch(() => undefined);

    const html = await page.content();
    if (options.screenshotPath) {
      await page
        .screenshot({ path: options.screenshotPath, fullPage: false })
        .catch((err: unknown) => logger.debug('Screenshot failed', { error: describeError(err) }));
    }

    const durationMs = Date.now() - startedAt;
    const status = response?.status() ?? 0;
    logger.debug('browser fetch complete', { status, bytes: html.length, durationMs });
    return { url, status, html, transport: 'playwright', durationMs };
  } finally {
    await context.close().catch(() => undefined);
  }
}
