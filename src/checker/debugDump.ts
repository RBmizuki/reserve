/**
 * Writes diagnostic snapshots to debug/ when a page cannot be understood.
 *
 * Contents are sanitised first: no cookies, no Authorization headers, no LINE
 * token, no form input, no session identifiers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.js';
import { logger } from '../logger.js';
import { describeError, redact } from '../redact.js';
import { sanitizeHtml } from '../parser/sanitize.js';

/** Keeps debug/ from growing without bound. */
export const MAX_DEBUG_SETS = 20;

function safeSlug(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
}

/** Deletes the oldest dumps so only {@link MAX_DEBUG_SETS} directories remain. */
function pruneOldDumps(): void {
  try {
    const entries = fs
      .readdirSync(PATHS.debug, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    while (entries.length > MAX_DEBUG_SETS) {
      const oldest = entries.shift();
      if (oldest) fs.rmSync(path.join(PATHS.debug, oldest), { recursive: true, force: true });
    }
  } catch {
    // Never let cleanup break a check.
  }
}

export interface DebugSnapshot {
  watchId: string;
  url: string;
  html: string | null;
  reason: string;
  signals: string[];
  transport: string;
  httpStatus?: number;
  /** Move the screenshot taken during the fetch into this snapshot. */
  includePendingScreenshot?: boolean;
}

/**
 * Scratch file the browser transport always writes its screenshot to.
 *
 * Reusing it means a failed check never costs the official site a second page
 * load just so we can photograph the problem.
 */
export function pendingScreenshotPath(): string {
  fs.mkdirSync(PATHS.debug, { recursive: true });
  return path.join(PATHS.debug, '.last-screenshot.png');
}

/**
 * Saves a snapshot and returns the directory it was written to
 * (or null if saving failed — which is never fatal).
 */
export function saveDebugSnapshot(snapshot: DebugSnapshot): string | null {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(PATHS.debug, `${stamp}_${safeSlug(snapshot.watchId)}`);
    fs.mkdirSync(dir, { recursive: true });

    const meta = {
      recordedAt: new Date().toISOString(),
      watchId: snapshot.watchId,
      // The URL is a public search URL with no credentials, but redact anyway.
      url: redact(snapshot.url),
      transport: snapshot.transport,
      httpStatus: snapshot.httpStatus ?? null,
      reason: redact(snapshot.reason),
      signals: snapshot.signals,
      note: 'Sanitised snapshot. Contains no cookies, tokens, session data or credentials.',
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    if (snapshot.html) {
      fs.writeFileSync(path.join(dir, 'page.sanitized.html'), sanitizeHtml(snapshot.html), 'utf8');
    }

    if (snapshot.includePendingScreenshot) {
      const pending = pendingScreenshotPath();
      if (fs.existsSync(pending)) {
        fs.renameSync(pending, path.join(dir, 'screenshot.png'));
      }
    }

    pruneOldDumps();
    logger.info('Saved debug snapshot', { dir: path.relative(PATHS.root, dir) });
    return dir;
  } catch (err) {
    logger.warn('Could not save debug snapshot', { error: describeError(err) });
    return null;
  }
}
