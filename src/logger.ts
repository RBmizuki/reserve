/**
 * Tiny rotating file logger.
 *
 * Writes human-readable lines to logs/monitor.log, and mirrors warn/error to
 * logs/error.log. Rotation keeps disk usage bounded (10 MB x 5 generations per
 * file) so the monitor can run for months unattended.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './config.js';
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const MAX_LOG_BYTES = 10 * 1024 * 1024;
export const MAX_LOG_GENERATIONS = 5;

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

/** "2026-09-10 12:00:00" in local time — matches what the user sees in `status`. */
export function timestamp(date: Date = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * Rotates `file` when it exceeds the size cap: monitor.log -> monitor.log.1 ->
 * ... -> monitor.log.5 (oldest discarded).
 */
function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // No file yet: nothing to rotate.
  }
  if (size < MAX_LOG_BYTES) return;

  try {
    const oldest = `${file}.${MAX_LOG_GENERATIONS}`;
    if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
    for (let i = MAX_LOG_GENERATIONS - 1; i >= 1; i--) {
      const from = `${file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    // Rotation is best-effort: never let logging take the monitor down.
  }
}

function append(file: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    // Disk full / permissions: keep running, the console still has the message.
  }
}

/** Renders `key=value` context pairs, skipping empty ones. */
function renderContext(context?: Record<string, unknown>): string {
  if (!context) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null || value === '') continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${key}=${String(text).replace(/\s+/g, ' ')}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/** When true, log lines are also printed to stdout/stderr. */
let echoToConsole = true;
export function setConsoleEcho(enabled: boolean): void {
  echoToConsole = enabled;
}

function write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;

  const line = redact(
    `${timestamp()} ${level.toUpperCase().padEnd(5)} ${message}${renderContext(context)}`,
  );
  append(path.join(PATHS.logs, 'monitor.log'), line);
  if (level === 'warn' || level === 'error') {
    append(path.join(PATHS.logs, 'error.log'), line);
  }
  if (echoToConsole) {
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }
}

export const logger: Logger = {
  debug: (m, c) => write('debug', m, c),
  info: (m, c) => write('info', m, c),
  warn: (m, c) => write('warn', m, c),
  error: (m, c) => write('error', m, c),
};
