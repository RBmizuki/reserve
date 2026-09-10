/**
 * `npm run check` — run every watch once and print the result.
 *
 * This is a real check: state is updated and (unless --dry-run) a notification
 * is sent, exactly as the background monitor would. That is deliberate — you
 * should be able to trust that what you see here is what the service does.
 */
import { enabledWatches, loadConfig } from '../config.js';
import { setConsoleEcho, timestamp } from '../logger.js';
import { LineNotifier } from '../notification/line.js';
import { runCheckCycle, type CycleDeps } from '../runCheck.js';
import { openStorage } from '../storage/sqlite.js';
import { closeBrowser } from '../checker/browser.js';
import type { CycleSummary } from '../runCheck.js';

/** Human-readable label for the result line. */
function resultLabel(summary: CycleSummary): string {
  switch (summary.outcome) {
    case 'available':
      return `AVAILABLE (${summary.availableRooms} room${summary.availableRooms === 1 ? '' : 's'})`;
    case 'unavailable':
      return 'NO_AVAILABILITY';
    case 'captcha':
      return 'STOPPED (bot-check page detected — not bypassed)';
    case 'blocked_by_robots':
      return 'STOPPED (robots.txt disallows this URL)';
    case 'network_error':
      return 'CHECK_FAILED (network / site unavailable)';
    case 'parser_error':
      return 'UNKNOWN (page not understood — NOT treated as sold out)';
    default:
      return 'UNKNOWN';
  }
}

export async function runCheckCommand(dryRun: boolean, onlyWatchId?: string): Promise<number> {
  const config = loadConfig();
  let watches = enabledWatches(config);
  if (onlyWatchId) {
    watches = watches.filter((w) => w.id === onlyWatchId);
    if (watches.length === 0) {
      process.stderr.write(`No enabled watch with id "${onlyWatchId}"\n`);
      return 1;
    }
  }
  if (watches.length === 0) {
    process.stderr.write('Every watch in config/watch.json is disabled.\n');
    return 1;
  }

  // Keep the console output clean: logs still go to logs/monitor.log.
  setConsoleEcho(false);

  const storage = openStorage();
  const deps: CycleDeps = {
    storage,
    notifier: new LineNotifier({ dryRun }),
    settings: config.settings,
  };

  const out = process.stdout;
  out.write('\nMiracosta Monitor\n');
  if (dryRun) out.write('(dry run — no LINE message will actually be sent)\n');

  let exitCode = 0;
  try {
    for (const watch of watches) {
      out.write('\n----------------------------------------\n');
      out.write(`Watch:\n${watch.id}\n\n`);
      out.write(`Checking:\n${watch.checkIn} (${watch.nights} night(s))\n\n`);
      out.write(`Adults:\n${watch.adults}\n\n`);
      if (watch.children > 0) out.write(`Children:\n${watch.children}\n\n`);
      out.write(
        `Rooms filter:\n${watch.roomKeywords.length > 0 ? watch.roomKeywords.join(' AND ') : '(any room in this hotel)'}\n\n`,
      );

      const summary = await runCheckCycle(deps, watch);

      out.write(`Result:\n${resultLabel(summary)}\n\n`);
      out.write(`Detail:\n${summary.reason}\n\n`);
      out.write(`Fetched via:\n${summary.transport} (${summary.durationMs} ms)\n\n`);
      if (summary.notificationsSent > 0) {
        out.write(`LINE:\nsent (${summary.notificationsSent} room(s))\n\n`);
      }
      if (summary.debugDir) out.write(`Debug snapshot:\n${summary.debugDir}\n\n`);
      out.write(`Checked:\n${timestamp()}\n`);

      if (summary.outcome === 'captcha' || summary.outcome === 'blocked_by_robots') exitCode = 2;
      else if (summary.outcome === 'parser_error' || summary.outcome === 'network_error') {
        if (exitCode === 0) exitCode = 1;
      }
    }
    out.write('\n');
  } finally {
    await closeBrowser();
    storage.close();
    setConsoleEcho(true);
  }

  return exitCode;
}
