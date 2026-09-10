/**
 * `npm run history` — what happened recently.
 */
import { openStorage } from '../storage/sqlite.js';

function fmt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function runHistoryCommand(limit: number): number {
  const storage = openStorage();
  const out = process.stdout;
  try {
    const checks = storage.recentChecks(limit);
    out.write(`\nMiracosta Monitor — last ${checks.length} check(s)\n\n`);
    if (checks.length === 0) {
      out.write('No checks recorded yet. Run:  npm run check\n\n');
      return 0;
    }

    out.write('  WHEN         WATCH                     RESULT           ROOMS  LINE  DETAIL\n');
    out.write('  ' + '-'.repeat(96) + '\n');
    for (const c of checks) {
      const when = fmt(c.checkedAt).padEnd(12);
      const watch = c.watchId.slice(0, 24).padEnd(25);
      const outcome = c.outcome.padEnd(16);
      const rooms = String(c.availableRooms).padStart(5);
      const line = (c.notified ? 'sent' : '-').padEnd(5);
      const detail = c.reason.replace(/\s+/g, ' ').slice(0, 60);
      out.write(`  ${when} ${watch} ${outcome} ${rooms}  ${line} ${detail}\n`);
    }

    const notifications = storage.recentNotifications(10);
    if (notifications.length > 0) {
      out.write('\nRecent LINE notifications\n\n');
      for (const n of notifications) {
        const status = n.success ? 'OK    ' : 'FAILED';
        out.write(
          `  ${fmt(n.sentAt)}  ${status}  ${n.kind.padEnd(16)} ${n.summary.slice(0, 60)}\n`,
        );
        if (!n.success && n.error) out.write(`                        └ ${n.error.slice(0, 80)}\n`);
      }
    }
    out.write('\n');
    return 0;
  } finally {
    storage.close();
  }
}
