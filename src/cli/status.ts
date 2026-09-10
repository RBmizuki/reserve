/**
 * `npm run status` — is the monitor alive, and what does it currently think?
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { enabledWatches, loadConfig, PATHS } from '../config.js';
import { LineNotifier } from '../notification/line.js';
import { SYSTEM_KEYS } from '../runCheck.js';
import { openStorage } from '../storage/sqlite.js';

export const LAUNCHD_LABEL = 'com.mizuki.miracosta-monitor';

function fmt(iso: string | null): string {
  if (!iso) return '(never)';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '(unknown)';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return ' (just now)';
  if (minutes < 60) return ` (${minutes} min ago)`;
  return ` (${Math.round(minutes / 60)} h ago)`;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reads the PID from the lock file the monitor writes while it runs. */
function runningPid(): number | null {
  const lock = path.join(PATHS.data, 'monitor.lock');
  try {
    const pid = Number.parseInt(fs.readFileSync(lock, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 && processAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Asks launchd whether the agent is registered. Silent on non-macOS. */
function launchdState(): string {
  if (process.platform !== 'darwin') return 'n/a (not macOS)';
  try {
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 5000 });
    const line = out.split('\n').find((l) => l.includes(LAUNCHD_LABEL));
    if (!line) return 'not installed';
    const [pid, status] = line.trim().split(/\s+/);
    if (pid && pid !== '-') return `loaded (PID ${pid})`;
    return status && status !== '0' ? `loaded, last exit code ${status}` : 'loaded (not running)';
  } catch {
    return 'unknown';
  }
}

function stateLabel(state: string, monitorBroken: number, suspended: string | null): string {
  if (suspended === 'captcha') return 'SUSPENDED (bot-check detected — needs a manual restart)';
  if (suspended === 'robots') return 'SUSPENDED (robots.txt disallows this URL)';
  if (monitorBroken === 1) return 'MONITOR_BROKEN (site structure changed — judgement paused)';
  switch (state) {
    case 'available':
      return 'AVAILABLE';
    case 'unavailable':
      return 'NO_AVAILABILITY';
    default:
      return 'UNKNOWN';
  }
}

export function runStatusCommand(): number {
  const out = process.stdout;
  out.write('\nMiracosta Monitor\n\n');

  const pid = runningPid();
  out.write(`Service:\n${pid ? 'RUNNING' : 'STOPPED'}\n\n`);
  if (pid) out.write(`PID:\n${pid}\n\n`);
  out.write(`launchd:\n${launchdState()}\n\n`);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    out.write(`Config:\nERROR — ${err instanceof Error ? err.message : String(err)}\n\n`);
    return 1;
  }

  const storage = openStorage();
  try {
    const lastCheck = storage.getSystemState(SYSTEM_KEYS.lastCheck);
    const lastSuccess = storage.getSystemState(SYSTEM_KEYS.lastSuccessfulCheck);
    const heartbeat = storage.getSystemState(SYSTEM_KEYS.lastHeartbeat);

    out.write(`Last check:\n${fmt(lastCheck)}${ago(lastCheck)}\n\n`);
    out.write(`Last successful check:\n${fmt(lastSuccess)}${ago(lastSuccess)}\n\n`);
    out.write(`Last heartbeat:\n${fmt(heartbeat)}${ago(heartbeat)}\n\n`);
    out.write(
      `LINE:\n${LineNotifier.isConfigured() ? 'OK (token and user id are set)' : 'NOT CONFIGURED — see README step 10'}\n\n`,
    );

    const staleAlert = storage.isAlertActive('stale', 'global');
    if (staleAlert) out.write('⚠️  A "no successful check" alert is currently active.\n\n');

    out.write('Watches:\n');
    for (const watch of enabledWatches(config)) {
      const rt = storage.getWatchRuntime(watch.id);
      const rooms = storage.listRoomStates(watch.id);
      const availableRooms = rooms.filter((r) => r.state === 'available');

      out.write(`\n  [${watch.id}]\n`);
      out.write(
        `    Date:            ${watch.checkIn} (${watch.nights} night(s), ${watch.adults} adult(s))\n`,
      );
      out.write(
        `    Filter:          ${watch.roomKeywords.length > 0 ? watch.roomKeywords.join(' AND ') : '(any room)'}\n`,
      );
      out.write(
        `    Current state:   ${stateLabel(rt.state, rt.monitorBroken, rt.suspendedReason)}\n`,
      );
      out.write(`    Last check:      ${fmt(rt.lastCheckAt)}${ago(rt.lastCheckAt)}\n`);
      out.write(`    Last success:    ${fmt(rt.lastSuccessAt)}${ago(rt.lastSuccessAt)}\n`);
      out.write(
        `    Next check:      ${rt.suspendedReason ? '(suspended)' : fmt(rt.nextCheckAt)}\n`,
      );
      out.write(`    Continuous errors: ${rt.consecutiveErrors}\n`);
      out.write(
        `    Known rooms:     ${rooms.length} (${availableRooms.length} currently available)\n`,
      );
      for (const room of availableRooms.slice(0, 5)) {
        out.write(
          `      • ${room.roomName}${room.price ? ` — ¥${room.price.toLocaleString('ja-JP')}` : ''}\n`,
        );
      }
    }

    const disabled = config.watches.filter((w) => !w.enabled);
    if (disabled.length > 0) {
      out.write(`\n  (disabled: ${disabled.map((w) => w.id).join(', ')})\n`);
    }
    out.write('\n');
    return 0;
  } finally {
    storage.close();
  }
}
