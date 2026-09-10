#!/usr/bin/env node
/**
 * CLI entry point.
 *
 * Everything is reachable through `npm run <command>`; this file only routes.
 */
import { ensureRuntimeDirs, ConfigError, loadEnv } from './config.js';
import { logger } from './logger.js';
import { isDryRun, parseArgs } from './cli/args.js';
import { runCheckCommand } from './cli/check.js';
import { runCaptureCommand } from './cli/capture.js';
import { runHistoryCommand } from './cli/history.js';
import { runSetupCommand } from './cli/setup.js';
import { runStatusCommand } from './cli/status.js';
import { runTestLineCommand } from './cli/testLine.js';
import { runMonitor } from './monitor.js';
import { describeError } from './redact.js';
import type { TransportKind } from './types.js';

const USAGE = `
Miracosta Monitor — watches the official Tokyo DisneySea Hotel MiraCosta
reservation site and sends a LINE message when a room opens up.

Usage:  npm run <command>

  setup                       First-run checks: folders, config, LINE, robots.txt
  check [-- --dry-run]        Check every watch once and print the result
  monitor [-- --dry-run]      Keep checking forever (this is what the service runs)
  test-line                   Send one test message to LINE
  status                      Is it running? What does it currently see?
  history [-- --limit 20]     Recent checks and notifications
  capture [-- --watch <id>]   Save a sanitised copy of the live page for debugging

  install-service             Register the launchd background service (macOS)
  start-service / stop-service / restart-service / uninstall-service

Options:
  --dry-run          Never actually send a LINE message (prints it instead)
  --watch <id>       Limit to one watch id from config/watch.json
  --limit <n>        How many history rows to show (default 20)
  --transport <k>    capture only: http | playwright | both (default both)
`;

async function main(): Promise<number> {
  loadEnv();
  ensureRuntimeDirs();

  const args = parseArgs(process.argv.slice(2));
  const dryRun = isDryRun(args);

  switch (args.command) {
    case 'setup':
      return runSetupCommand();

    case 'check':
      return runCheckCommand(dryRun, args.options.get('watch'));

    case 'monitor':
      return runMonitor({ dryRun });

    case 'test-line':
      return runTestLineCommand(dryRun);

    case 'status':
      return runStatusCommand();

    case 'history': {
      const raw = Number.parseInt(args.options.get('limit') ?? '20', 10);
      return runHistoryCommand(Number.isFinite(raw) && raw > 0 ? Math.min(raw, 500) : 20);
    }

    case 'capture': {
      const requested = args.options.get('transport') ?? 'both';
      const transport: TransportKind | 'both' =
        requested === 'http' || requested === 'playwright' ? requested : 'both';
      return runCaptureCommand(args.options.get('watch'), transport);
    }

    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;

    default:
      process.stderr.write(`Unknown command: ${args.command}\n${USAGE}`);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof ConfigError) {
      process.stderr.write(`\nConfiguration problem:\n\n${err.message}\n\n`);
    } else {
      const message = describeError(err);
      process.stderr.write(`\nUnexpected error: ${message}\n\n`);
      logger.error('CLI failed', { error: message });
    }
    process.exitCode = 1;
  });
