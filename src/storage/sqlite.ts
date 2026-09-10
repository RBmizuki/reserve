/**
 * SQLite persistence.
 *
 * Everything the monitor needs to survive a restart lives here: per-room
 * availability state (so we only notify on a real change), per-watch runtime
 * (backoff, next check), de-duplicated alerts, and history.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PATHS } from '../config.js';
import type {
  AlertKind,
  AvailabilityState,
  CheckOutcome,
  RoomOffer,
  WatchCondition,
} from '../types.js';

export interface RoomStateRow {
  watchId: string;
  roomKey: string;
  state: AvailabilityState;
  roomName: string;
  side: string | null;
  view: string | null;
  planName: string | null;
  price: number | null;
  url: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastStateChangeAt: string;
  lastNotifiedAt: string | null;
  /**
   * 1 when this room became available and the LINE message has not been
   * delivered yet. Set at transition time, cleared only after a successful
   * send, so a LINE outage delays a notification instead of losing it.
   */
  notifyPending: number;
}

export interface WatchRuntimeRow {
  watchId: string;
  state: AvailabilityState;
  consecutiveErrors: number;
  consecutiveParserErrors: number;
  monitorBroken: number;
  nextCheckAt: string | null;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  suspendedReason: string | null;
}

export interface CheckHistoryRow {
  id: number;
  watchId: string;
  checkedAt: string;
  outcome: CheckOutcome;
  reason: string;
  transport: string;
  httpStatus: number | null;
  durationMs: number;
  availableRooms: number;
  notified: number;
}

export interface NotificationRow {
  id: number;
  kind: string;
  watchId: string | null;
  roomKey: string | null;
  summary: string;
  sentAt: string;
  success: number;
  error: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watch_conditions (
  watch_id        TEXT PRIMARY KEY,
  hotel           TEXT NOT NULL,
  check_in        TEXT NOT NULL,
  nights          INTEGER NOT NULL,
  adults          INTEGER NOT NULL,
  children        INTEGER NOT NULL,
  rooms           INTEGER NOT NULL,
  room_keywords   TEXT NOT NULL,
  plan_keywords   TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_states (
  watch_id             TEXT NOT NULL,
  room_key             TEXT NOT NULL,
  state                TEXT NOT NULL,
  room_name            TEXT NOT NULL,
  side                 TEXT,
  view                 TEXT,
  plan_name            TEXT,
  price                INTEGER,
  url                  TEXT,
  first_seen_at        TEXT NOT NULL,
  last_seen_at         TEXT NOT NULL,
  last_state_change_at TEXT NOT NULL,
  last_notified_at     TEXT,
  notify_pending       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (watch_id, room_key)
);

CREATE TABLE IF NOT EXISTS watch_runtime (
  watch_id                  TEXT PRIMARY KEY,
  state                     TEXT NOT NULL DEFAULT 'unknown',
  consecutive_errors        INTEGER NOT NULL DEFAULT 0,
  consecutive_parser_errors INTEGER NOT NULL DEFAULT 0,
  monitor_broken            INTEGER NOT NULL DEFAULT 0,
  next_check_at             TEXT,
  last_check_at             TEXT,
  last_success_at           TEXT,
  suspended_reason          TEXT
);

CREATE TABLE IF NOT EXISTS check_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id       TEXT NOT NULL,
  checked_at     TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  reason         TEXT NOT NULL,
  transport      TEXT NOT NULL,
  http_status    INTEGER,
  duration_ms    INTEGER NOT NULL,
  available_rooms INTEGER NOT NULL DEFAULT 0,
  notified       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_check_history_time ON check_history (checked_at DESC);

CREATE TABLE IF NOT EXISTS notification_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind      TEXT NOT NULL,
  watch_id  TEXT,
  room_key  TEXT,
  summary   TEXT NOT NULL,
  sent_at   TEXT NOT NULL,
  success   INTEGER NOT NULL,
  error     TEXT
);
CREATE INDEX IF NOT EXISTS idx_notification_time ON notification_history (sent_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
  kind         TEXT NOT NULL,
  scope        TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 0,
  last_sent_at TEXT,
  PRIMARY KEY (kind, scope)
);

CREATE TABLE IF NOT EXISTS system_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** How many rows of history we keep, so the DB never grows without bound. */
const CHECK_HISTORY_LIMIT = 5000;
const NOTIFICATION_HISTORY_LIMIT = 1000;

export class Storage {
  private readonly db: Database.Database;

  constructor(file: string = PATHS.db) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Already closed: nothing to do.
    }
  }

  // --- watch conditions ----------------------------------------------------

  /** Records the conditions currently configured, for `history` and auditing. */
  upsertWatchCondition(watch: WatchCondition): void {
    this.db
      .prepare(
        `INSERT INTO watch_conditions
           (watch_id, hotel, check_in, nights, adults, children, rooms, room_keywords, plan_keywords, updated_at)
         VALUES (@watchId, @hotel, @checkIn, @nights, @adults, @children, @rooms, @roomKeywords, @planKeywords, @updatedAt)
         ON CONFLICT(watch_id) DO UPDATE SET
           hotel=excluded.hotel, check_in=excluded.check_in, nights=excluded.nights,
           adults=excluded.adults, children=excluded.children, rooms=excluded.rooms,
           room_keywords=excluded.room_keywords, plan_keywords=excluded.plan_keywords,
           updated_at=excluded.updated_at`,
      )
      .run({
        watchId: watch.id,
        hotel: watch.hotel,
        checkIn: watch.checkIn,
        nights: watch.nights,
        adults: watch.adults,
        children: watch.children,
        rooms: watch.rooms,
        roomKeywords: JSON.stringify(watch.roomKeywords),
        planKeywords: JSON.stringify(watch.planKeywords),
        updatedAt: new Date().toISOString(),
      });
  }

  // --- room states ---------------------------------------------------------

  getRoomState(watchId: string, roomKey: string): RoomStateRow | null {
    const row = this.db
      .prepare(
        `SELECT watch_id AS watchId, room_key AS roomKey, state, room_name AS roomName,
                side, view, plan_name AS planName, price, url,
                first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
                last_state_change_at AS lastStateChangeAt, last_notified_at AS lastNotifiedAt,
                notify_pending AS notifyPending
         FROM room_states WHERE watch_id = ? AND room_key = ?`,
      )
      .get(watchId, roomKey) as RoomStateRow | undefined;
    return row ?? null;
  }

  listRoomStates(watchId: string): RoomStateRow[] {
    return this.db
      .prepare(
        `SELECT watch_id AS watchId, room_key AS roomKey, state, room_name AS roomName,
                side, view, plan_name AS planName, price, url,
                first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
                last_state_change_at AS lastStateChangeAt, last_notified_at AS lastNotifiedAt,
                notify_pending AS notifyPending
         FROM room_states WHERE watch_id = ? ORDER BY room_name`,
      )
      .all(watchId) as RoomStateRow[];
  }

  /** Writes the new state for a room, stamping the change time when it moved. */
  setRoomState(
    watchId: string,
    roomKey: string,
    state: AvailabilityState,
    offer: RoomOffer | null,
    now: string,
    changed: boolean,
    notifyPending?: boolean,
  ): void {
    const existing = this.getRoomState(watchId, roomKey);
    const stateChangeAt = changed || !existing ? now : existing.lastStateChangeAt;

    this.db
      .prepare(
        `INSERT INTO room_states
           (watch_id, room_key, state, room_name, side, view, plan_name, price, url,
            first_seen_at, last_seen_at, last_state_change_at, last_notified_at, notify_pending)
         VALUES (@watchId, @roomKey, @state, @roomName, @side, @view, @planName, @price, @url,
                 @now, @now, @stateChangeAt, NULL, @notifyPending)
         ON CONFLICT(watch_id, room_key) DO UPDATE SET
           state=excluded.state,
           room_name=CASE WHEN excluded.room_name != '' THEN excluded.room_name ELSE room_states.room_name END,
           side=COALESCE(excluded.side, room_states.side),
           view=COALESCE(excluded.view, room_states.view),
           plan_name=COALESCE(excluded.plan_name, room_states.plan_name),
           price=COALESCE(excluded.price, room_states.price),
           url=COALESCE(excluded.url, room_states.url),
           last_seen_at=excluded.last_seen_at,
           last_state_change_at=@stateChangeAt,
           notify_pending=@notifyPending`,
      )
      .run({
        watchId,
        roomKey,
        state,
        roomName: offer?.roomName ?? existing?.roomName ?? '',
        side: offer?.side ?? null,
        view: offer?.view ?? null,
        planName: offer?.planName ?? null,
        price: offer?.price ?? null,
        url: offer?.url ?? null,
        now,
        stateChangeAt,
        notifyPending:
          notifyPending === undefined ? (existing?.notifyPending ?? 0) : notifyPending ? 1 : 0,
      });
  }

  /** Called only after LINE confirmed delivery: clears the pending flag. */
  markRoomNotified(watchId: string, roomKey: string, at: string): void {
    this.db
      .prepare(
        `UPDATE room_states SET last_notified_at = ?, notify_pending = 0
         WHERE watch_id = ? AND room_key = ?`,
      )
      .run(at, watchId, roomKey);
  }

  // --- watch runtime -------------------------------------------------------

  getWatchRuntime(watchId: string): WatchRuntimeRow {
    const row = this.db
      .prepare(
        `SELECT watch_id AS watchId, state, consecutive_errors AS consecutiveErrors,
                consecutive_parser_errors AS consecutiveParserErrors,
                monitor_broken AS monitorBroken, next_check_at AS nextCheckAt,
                last_check_at AS lastCheckAt, last_success_at AS lastSuccessAt,
                suspended_reason AS suspendedReason
         FROM watch_runtime WHERE watch_id = ?`,
      )
      .get(watchId) as WatchRuntimeRow | undefined;
    if (row) return row;

    const fresh: WatchRuntimeRow = {
      watchId,
      state: 'unknown',
      consecutiveErrors: 0,
      consecutiveParserErrors: 0,
      monitorBroken: 0,
      nextCheckAt: null,
      lastCheckAt: null,
      lastSuccessAt: null,
      suspendedReason: null,
    };
    this.saveWatchRuntime(fresh);
    return fresh;
  }

  saveWatchRuntime(runtime: WatchRuntimeRow): void {
    this.db
      .prepare(
        `INSERT INTO watch_runtime
           (watch_id, state, consecutive_errors, consecutive_parser_errors, monitor_broken,
            next_check_at, last_check_at, last_success_at, suspended_reason)
         VALUES (@watchId, @state, @consecutiveErrors, @consecutiveParserErrors, @monitorBroken,
                 @nextCheckAt, @lastCheckAt, @lastSuccessAt, @suspendedReason)
         ON CONFLICT(watch_id) DO UPDATE SET
           state=excluded.state,
           consecutive_errors=excluded.consecutive_errors,
           consecutive_parser_errors=excluded.consecutive_parser_errors,
           monitor_broken=excluded.monitor_broken,
           next_check_at=excluded.next_check_at,
           last_check_at=excluded.last_check_at,
           last_success_at=excluded.last_success_at,
           suspended_reason=excluded.suspended_reason`,
      )
      .run(runtime);
  }

  // --- alerts (de-duplicated) ---------------------------------------------

  /**
   * Returns true when this alert was not already active, and marks it active.
   * Used so a broken site produces one LINE message, not one every 5 minutes.
   */
  raiseAlert(kind: AlertKind, scope: string, now: string): boolean {
    const row = this.db
      .prepare('SELECT active FROM alerts WHERE kind = ? AND scope = ?')
      .get(kind, scope) as { active: number } | undefined;
    if (row?.active === 1) return false;
    this.db
      .prepare(
        `INSERT INTO alerts (kind, scope, active, last_sent_at) VALUES (?, ?, 1, ?)
         ON CONFLICT(kind, scope) DO UPDATE SET active = 1, last_sent_at = excluded.last_sent_at`,
      )
      .run(kind, scope, now);
    return true;
  }

  /** Clears an alert. Returns true if it had been active (i.e. this is a recovery). */
  clearAlert(kind: AlertKind, scope: string): boolean {
    const row = this.db
      .prepare('SELECT active FROM alerts WHERE kind = ? AND scope = ?')
      .get(kind, scope) as { active: number } | undefined;
    if (!row || row.active === 0) return false;
    this.db.prepare('UPDATE alerts SET active = 0 WHERE kind = ? AND scope = ?').run(kind, scope);
    return true;
  }

  isAlertActive(kind: AlertKind, scope: string): boolean {
    const row = this.db
      .prepare('SELECT active FROM alerts WHERE kind = ? AND scope = ?')
      .get(kind, scope) as { active: number } | undefined;
    return row?.active === 1;
  }

  // --- history -------------------------------------------------------------

  recordCheck(entry: Omit<CheckHistoryRow, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO check_history
           (watch_id, checked_at, outcome, reason, transport, http_status, duration_ms, available_rooms, notified)
         VALUES (@watchId, @checkedAt, @outcome, @reason, @transport, @httpStatus, @durationMs, @availableRooms, @notified)`,
      )
      .run(entry);
    this.db
      .prepare(
        `DELETE FROM check_history WHERE id NOT IN
           (SELECT id FROM check_history ORDER BY id DESC LIMIT ?)`,
      )
      .run(CHECK_HISTORY_LIMIT);
  }

  recordNotification(entry: Omit<NotificationRow, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO notification_history (kind, watch_id, room_key, summary, sent_at, success, error)
         VALUES (@kind, @watchId, @roomKey, @summary, @sentAt, @success, @error)`,
      )
      .run(entry);
    this.db
      .prepare(
        `DELETE FROM notification_history WHERE id NOT IN
           (SELECT id FROM notification_history ORDER BY id DESC LIMIT ?)`,
      )
      .run(NOTIFICATION_HISTORY_LIMIT);
  }

  recentChecks(limit: number): CheckHistoryRow[] {
    return this.db
      .prepare(
        `SELECT id, watch_id AS watchId, checked_at AS checkedAt, outcome, reason, transport,
                http_status AS httpStatus, duration_ms AS durationMs,
                available_rooms AS availableRooms, notified
         FROM check_history ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as CheckHistoryRow[];
  }

  recentNotifications(limit: number): NotificationRow[] {
    return this.db
      .prepare(
        `SELECT id, kind, watch_id AS watchId, room_key AS roomKey, summary,
                sent_at AS sentAt, success, error
         FROM notification_history ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as NotificationRow[];
  }

  // --- system state --------------------------------------------------------

  setSystemState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO system_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  getSystemState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM system_state WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }
}

/** Opens the database at the default location. */
export function openStorage(): Storage {
  return new Storage();
}
