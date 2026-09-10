/**
 * `npm run capture` — fetch the real page once and show exactly what the parser
 * makes of it, then save a sanitised copy under tests/fixtures/.
 *
 * This is the tool to reach for when the site changes: it turns "the monitor
 * says UNKNOWN" into a concrete, inspectable file plus a printed diagnosis, and
 * the saved fixture can be replayed by the test suite without touching the site
 * again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fetchViaBrowser } from '../checker/browser.js';
import { fetchViaHttp } from '../checker/http.js';
import { resolveHotel, buildSearchUrl } from '../checker/url.js';
import { enabledWatches, loadConfig, PATHS } from '../config.js';
import { setConsoleEcho } from '../logger.js';
import { parseAvailability } from '../parser/availability.js';
import { sanitizeHtml } from '../parser/sanitize.js';
import { describeError } from '../redact.js';
import type { FetchedPage, TransportKind } from '../types.js';

const FIXTURE_DIR = path.join(PATHS.root, 'tests', 'fixtures');

export async function runCaptureCommand(
  watchId: string | undefined,
  transport: TransportKind | 'both',
): Promise<number> {
  setConsoleEcho(false);
  const out = process.stdout;
  const config = loadConfig();
  const watches = enabledWatches(config);
  const watch = watchId ? watches.find((w) => w.id === watchId) : watches[0];
  if (!watch) {
    process.stderr.write(`No enabled watch${watchId ? ` with id "${watchId}"` : ''}.\n`);
    return 1;
  }

  const hotel = resolveHotel(watch);
  const url = buildSearchUrl(watch);
  out.write('\nMiracosta Monitor — capture\n\n');
  out.write(`Watch:\n${watch.id}\n\nURL:\n${url}\n\n`);

  const transports: TransportKind[] = transport === 'both' ? ['http', 'playwright'] : [transport];
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  let anySuccess = false;

  for (const kind of transports) {
    out.write('----------------------------------------\n');
    out.write(`Transport: ${kind}\n\n`);

    let page: FetchedPage;
    try {
      page = kind === 'http' ? await fetchViaHttp(url) : await fetchViaBrowser(url);
    } catch (err) {
      out.write(`  Fetch failed: ${describeError(err)}\n\n`);
      continue;
    }

    out.write(`  HTTP status: ${page.status}\n`);
    out.write(`  Bytes:       ${page.html.length}\n`);
    out.write(`  Duration:    ${page.durationMs} ms\n\n`);

    const parsed = parseAvailability(page.html, {
      hotelCode: hotel.code,
      hotelName: hotel.name,
      fallbackUrl: url,
    });

    out.write(`  Parser outcome: ${parsed.outcome}\n`);
    out.write(`  Reason:         ${parsed.reason}\n`);
    out.write(`  Signals:        ${parsed.signals.join(', ') || '(none)'}\n`);
    out.write(`  Room rows seen: ${parsed.rooms.length}\n\n`);

    for (const room of parsed.rooms.slice(0, 15)) {
      out.write(
        `    [${room.state.padEnd(11)}] ${room.offer.officialRoomCode ?? '(no code)'} ` +
          `${room.offer.roomName.slice(0, 60)}${room.offer.priceText ? ` — ${room.offer.priceText}` : ''}\n`,
      );
    }
    if (parsed.rooms.length > 15) out.write(`    ... and ${parsed.rooms.length - 15} more\n`);
    out.write('\n');

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const file = path.join(FIXTURE_DIR, `captured-${stamp}-${watch.id}-${kind}.html`);
    fs.writeFileSync(file, sanitizeHtml(page.html), 'utf8');
    out.write(`  Saved sanitised fixture:\n  ${path.relative(PATHS.root, file)}\n\n`);
    if (parsed.outcome === 'available' || parsed.outcome === 'unavailable') anySuccess = true;
  }

  if (!anySuccess) {
    out.write(
      'The parser could not read the page with any transport.\n' +
        'That means the site changed, or it is blocking this machine.\n\n' +
        'What to do:\n' +
        '  1. Open the URL above in Safari or Chrome on this Mac.\n' +
        '  2. If it shows a normal search result, send the saved fixture file to\n' +
        '     whoever maintains this tool — the phrases in src/parser/signals.ts\n' +
        '     need updating.\n' +
        '  3. If it shows a bot-check or access-restriction page, stop here.\n' +
        '     Do not try to work around it.\n\n',
    );
    return 1;
  }
  return 0;
}
