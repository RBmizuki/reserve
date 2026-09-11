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
        '  2. Open .env and fill in LINE_CHANNEL_ACCESS_TOKEN, then either\n' +
        '     LINE_BROADCAST=1 (everyone who added the bot) or LINE_TO=<your id>\n' +
        '     (README steps 5-10 explain where to find them)\n' +
        '  3. Run this command again\n\n',
    );
    return 1;
  }

  // Showing this before sending is the whole point of the command: it is how
  // you notice that a second person is not actually on the list.
  if (!dryRun) out.write(`Sending to: ${LineNotifier.describeRecipients()}\n\n`);

  const notifier = new LineNotifier({ dryRun });
  const result = await notifier.send(testMessage());

  if (result.ok) {
    if (dryRun) {
      out.write('Dry run finished — nothing was sent.\n\n');
    } else {
      out.write('✅ Sent. Check LINE on every phone that should receive alerts.\n\n');
      out.write(
        'Reached you but not someone else?\n' +
          '  • They must add this bot as a friend (QR code in LINE Developers\n' +
          '    > Messaging API tab).\n' +
          '  • A friend\u2019s user id is NOT shown in the console, so listing them\n' +
          '    in LINE_TO is usually impossible. Set LINE_BROADCAST=1 instead.\n' +
          '  See README section 9.\n\n',
      );
    }
    return 0;
  }

  process.stderr.write(`❌ Could not send: ${result.error ?? 'unknown error'}\n\n`);
  process.stderr.write(
    'Common causes:\n' +
      '  • The channel access token was copied incompletely, or has been reissued\n' +
      '  • LINE_TO holds a channel/bot id instead of a user id (it starts with "U")\n' +
      '  • The recipient has not added this bot as a friend in LINE yet\n' +
      '  • No internet connection\n\n',
  );
  return 1;
}
