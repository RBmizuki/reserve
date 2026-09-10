/**
 * Configuration loading and validation.
 *
 * Two sources, deliberately separated:
 *   - .env            -> secrets only (LINE token, LINE user id)
 *   - config/watch.json -> everything you are expected to edit day to day
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { findHotel, hotelKeys } from './checker/hotels.js';
import type { AppConfig, MonitorSettings, WatchCondition } from './types.js';

/** Repository root, resolved from this file's location (works under launchd). */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PATHS = {
  root: PROJECT_ROOT,
  data: path.join(PROJECT_ROOT, 'data'),
  logs: path.join(PROJECT_ROOT, 'logs'),
  debug: path.join(PROJECT_ROOT, 'debug'),
  config: path.join(PROJECT_ROOT, 'config'),
  db: path.join(PROJECT_ROOT, 'data', 'monitor.db'),
  env: path.join(PROJECT_ROOT, '.env'),
} as const;

export function ensureRuntimeDirs(): void {
  for (const dir of [PATHS.data, PATHS.logs, PATHS.debug]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let envLoaded = false;
/** Loads .env exactly once. Safe to call from every entry point. */
export function loadEnv(): void {
  if (envLoaded) return;
  dotenv.config({ path: PATHS.env, quiet: true });
  envLoaded = true;
}

export interface LineCredentials {
  channelAccessToken: string;
  userId: string;
}

/**
 * Reads LINE credentials from the environment.
 * Returns null (rather than throwing) so `check --dry-run` works with no .env.
 */
export function readLineCredentials(): LineCredentials | null {
  loadEnv();
  const channelAccessToken = (process.env.LINE_CHANNEL_ACCESS_TOKEN ?? '').trim();
  const userId = (process.env.LINE_USER_ID ?? '').trim();
  if (!channelAccessToken || !userId) return null;
  return { channelAccessToken, userId };
}

export const DEFAULT_SETTINGS: MonitorSettings = {
  intervalMinutes: 10,
  jitterPercent: 15,
  minRequestSpacingSeconds: 20,
  backoffBaseMinutes: 5,
  backoffMaxMinutes: 60,
  notifyOnInitialAvailability: true,
  staleAfterMinutes: 30,
  parserErrorThreshold: 3,
  transport: 'auto',
  respectRobotsTxt: true,
  saveDebugOnParserError: true,
};

/**
 * Hard floor on how often we may contact the official site, per watch.
 * Config cannot go below this; being polite is not negotiable.
 */
export const MIN_INTERVAL_MINUTES = 5;
/** Hard floor on the gap between any two outbound requests. */
export const MIN_REQUEST_SPACING_SECONDS = 10;

export class ConfigError extends Error {}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function num(raw: unknown, fallback: number, where: string, min: number, max: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ConfigError(`${where} must be a number`);
  }
  if (raw < min || raw > max) {
    throw new ConfigError(`${where} must be between ${min} and ${max} (got ${raw})`);
  }
  return raw;
}

function bool(raw: unknown, fallback: boolean, where: string): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'boolean') throw new ConfigError(`${where} must be true or false`);
  return raw;
}

function stringArray(raw: unknown, where: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigError(`${where} must be an array of strings`);
  return raw
    .map((v, i) => {
      if (typeof v !== 'string') throw new ConfigError(`${where}[${i}] must be a string`);
      return v.trim();
    })
    .filter((v) => v.length > 0);
}

function parseSettings(raw: unknown): MonitorSettings {
  if (raw === undefined) return { ...DEFAULT_SETTINGS };
  const o = asRecord(raw, 'settings');
  const transportRaw = o.transport ?? DEFAULT_SETTINGS.transport;
  if (transportRaw !== 'auto' && transportRaw !== 'http' && transportRaw !== 'playwright') {
    throw new ConfigError('settings.transport must be "auto", "http" or "playwright"');
  }

  const intervalMinutes = num(
    o.intervalMinutes,
    DEFAULT_SETTINGS.intervalMinutes,
    'settings.intervalMinutes',
    MIN_INTERVAL_MINUTES,
    24 * 60,
  );
  const minRequestSpacingSeconds = num(
    o.minRequestSpacingSeconds,
    DEFAULT_SETTINGS.minRequestSpacingSeconds,
    'settings.minRequestSpacingSeconds',
    MIN_REQUEST_SPACING_SECONDS,
    600,
  );

  return {
    intervalMinutes,
    jitterPercent: num(
      o.jitterPercent,
      DEFAULT_SETTINGS.jitterPercent,
      'settings.jitterPercent',
      0,
      50,
    ),
    minRequestSpacingSeconds,
    backoffBaseMinutes: num(
      o.backoffBaseMinutes,
      DEFAULT_SETTINGS.backoffBaseMinutes,
      'settings.backoffBaseMinutes',
      1,
      120,
    ),
    backoffMaxMinutes: num(
      o.backoffMaxMinutes,
      DEFAULT_SETTINGS.backoffMaxMinutes,
      'settings.backoffMaxMinutes',
      5,
      24 * 60,
    ),
    notifyOnInitialAvailability: bool(
      o.notifyOnInitialAvailability,
      DEFAULT_SETTINGS.notifyOnInitialAvailability,
      'settings.notifyOnInitialAvailability',
    ),
    staleAfterMinutes: num(
      o.staleAfterMinutes,
      DEFAULT_SETTINGS.staleAfterMinutes,
      'settings.staleAfterMinutes',
      5,
      24 * 60,
    ),
    parserErrorThreshold: num(
      o.parserErrorThreshold,
      DEFAULT_SETTINGS.parserErrorThreshold,
      'settings.parserErrorThreshold',
      1,
      50,
    ),
    transport: transportRaw,
    respectRobotsTxt: bool(
      o.respectRobotsTxt,
      DEFAULT_SETTINGS.respectRobotsTxt,
      'settings.respectRobotsTxt',
    ),
    saveDebugOnParserError: bool(
      o.saveDebugOnParserError,
      DEFAULT_SETTINGS.saveDebugOnParserError,
      'settings.saveDebugOnParserError',
    ),
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseWatch(raw: unknown, index: number): WatchCondition {
  const where = `watches[${index}]`;
  const o = asRecord(raw, where);

  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id) throw new ConfigError(`${where}.id is required (a short unique name)`);
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new ConfigError(
      `${where}.id may only contain letters, numbers, dot, dash and underscore`,
    );
  }

  const hotel = typeof o.hotel === 'string' ? o.hotel.trim() : 'miracosta';
  if (!findHotel(hotel)) {
    throw new ConfigError(
      `${where}.hotel "${hotel}" is unknown. Valid values: ${hotelKeys().join(', ')}`,
    );
  }

  const checkIn = typeof o.checkIn === 'string' ? o.checkIn.trim() : '';
  if (!ISO_DATE.test(checkIn)) throw new ConfigError(`${where}.checkIn must be "YYYY-MM-DD"`);
  if (Number.isNaN(Date.parse(`${checkIn}T00:00:00Z`))) {
    throw new ConfigError(`${where}.checkIn is not a real date: ${checkIn}`);
  }

  return {
    id,
    hotel,
    checkIn,
    nights: num(o.nights, 1, `${where}.nights`, 1, 5),
    adults: num(o.adults, 2, `${where}.adults`, 1, 6),
    children: num(o.children, 0, `${where}.children`, 0, 6),
    rooms: num(o.rooms, 1, `${where}.rooms`, 1, 3),
    roomKeywords: stringArray(o.roomKeywords, `${where}.roomKeywords`),
    planKeywords: stringArray(o.planKeywords, `${where}.planKeywords`),
    enabled: bool(o.enabled, true, `${where}.enabled`),
  };
}

export function parseConfig(raw: unknown): AppConfig {
  const o = asRecord(raw, 'config');
  const settings = parseSettings(o.settings);

  if (!Array.isArray(o.watches)) throw new ConfigError('config must contain a "watches" array');
  if (o.watches.length === 0) {
    throw new ConfigError('"watches" is empty — add at least one condition');
  }

  const watches = o.watches.map(parseWatch);
  const seen = new Set<string>();
  for (const w of watches) {
    if (seen.has(w.id)) throw new ConfigError(`Duplicate watch id "${w.id}" — ids must be unique`);
    seen.add(w.id);
  }
  return { settings, watches };
}

export function watchConfigPath(): string {
  loadEnv();
  const override = (process.env.WATCH_CONFIG ?? '').trim();
  if (override) return path.isAbsolute(override) ? override : path.join(PROJECT_ROOT, override);
  return path.join(PATHS.config, 'watch.json');
}

/** Reads and validates config/watch.json. Throws {@link ConfigError} with a readable message. */
export function loadConfig(): AppConfig {
  const file = watchConfigPath();
  if (!fs.existsSync(file)) {
    throw new ConfigError(
      `Config file not found: ${file}\n` +
        `Create it with:  cp config/watch.example.json config/watch.json`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseConfig(parsed);
}

/** Watches that are switched on. */
export function enabledWatches(config: AppConfig): WatchCondition[] {
  return config.watches.filter((w) => w.enabled);
}
