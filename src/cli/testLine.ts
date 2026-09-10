/**
 * `npm run test-line` — proves the LINE settings work, and nothing else.
 */
import { LineNotifier } from '../notification/line.js';
import { testMessage } from '../notification/messages.js';
import { setConsoleEcho } from '../logger.js';

export async function runTestLineCommand(dryRun: boolean): Promise<number> {
  setConsoleEcho(false);
  const out = process.stdout;
  out.write('\nMiracosta Monitor — LINE test\n\n');

  if (!dryRun && !LineNotifier.isConfigured()) {
    process.stderr.write(
      'LINE is not configured.\n\n' +
        'Do this:\n' +
        '  1. cp .env.example .env\n' +
        '  2. Open .env and fill in LINE_CHANNEL_ACCESS_TOKEN and LINE_USER_ID\n' +
        '     (README steps 5-10 explain where to find them)\n' +
        '  3. Run this command again\n\n',
    );
    return 1;
  }

  const notifier = new LineNotifier({ dryRun });
  const result = await notifier.send(testMessage());

  if (result.ok) {
    out.write(
      dryRun
        ? 'Dry run finished — nothing was sent.\n\n'
        : '✅ Sent. Check LINE on your phone.\n\n',
    );
    return 0;
  }

  process.stderr.write(`❌ Could not send: ${result.error ?? 'unknown error'}\n\n`);
  process.stderr.write(
    'Common causes:\n' +
      '  • The channel access token was copied incompletely, or has been reissued\n' +
      '  • LINE_USER_ID is a channel/bot id instead of YOUR user id (it starts with "U")\n' +
      '  • You have not added your own bot as a friend in LINE yet\n' +
      '  • No internet connection\n\n',
  );
  return 1;
}
