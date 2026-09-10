/**
 * Shared domain types.
 *
 * Kept in one small file on purpose: this is a personal tool, and having the
 * whole vocabulary visible in one place makes the state machine easy to audit.
 */

/** Availability of one room (or of a whole search) at one point in time. */
export type AvailabilityState =
  /** The official site positively showed this room as bookable. */
  | 'available'
  /** The official site positively showed "no rooms" / sold out. */
  | 'unavailable'
  /**
   * We could not tell. NEVER treated as "sold out".
   * Produced by network errors, parser failures, or unrecognised pages.
   */
  | 'unknown';

/**
 * Why a check ended the way it did. This is richer than {@link AvailabilityState}
 * because the monitor reacts differently to "sold out" vs "the site changed".
 */
export type CheckOutcome =
  /** Parsed fine, at least one matching room was bookable. */
  | 'available'
  /** Parsed fine, the site positively said there is nothing to book. */
  | 'unavailable'
  /** Network / DNS / timeout / 5xx. Retry with backoff. */
  | 'network_error'
  /** The page loaded but we could not recognise it. Do NOT assume sold out. */
  | 'parser_error'
  /** A CAPTCHA or bot-check page was shown. We stop; we never solve it. */
  | 'captcha'
  /** robots.txt (or our own config) forbids checking this URL. */
  | 'blocked_by_robots';

/** One room offer extracted from a search result page. */
export interface RoomOffer {
  /**
   * Stable key for this room.
   * Prefers the official `hotelRoomCd` when the page exposes one
   * (e.g. "HOTDHRBC0001N"); otherwise derived from hotel+name+view+plan.
   */
  roomKey: string;
  /** The official room code, when the page exposed one. */
  officialRoomCode: string | null;
  hotelCode: string;
  hotelName: string;
  /** e.g. "スペチアーレ・ルーム＆スイート バルコニールーム" */
  roomName: string;
  /** e.g. "ポルト・パラディーゾ・サイド" */
  side: string | null;
  /** e.g. "ハーバービュー" */
  view: string | null;
  /** Stay plan name, when shown. */
  planName: string | null;
  /** Total price in JPY, when shown. */
  price: number | null;
  /** Raw price text as displayed, for the notification. */
  priceText: string | null;
  /** Deep link to the official page for this room, when it is a stable public URL. */
  url: string | null;
}

/** One room row on the page, together with what the page said about it. */
export interface RoomObservation {
  offer: RoomOffer;
  /** Only 'available' or 'unavailable': ambiguous rows never reach here. */
  state: Extract<AvailabilityState, 'available' | 'unavailable'>;
}

/** Result of parsing one search-result page. */
export interface ParseResult {
  outcome: CheckOutcome;
  /** Rooms the page positively showed as bookable. Empty unless outcome==='available'. */
  offers: RoomOffer[];
  /**
   * Every room row we could classify, bookable or not.
   *
   * Sold-out rows matter: recording them means a room that was full on the very
   * first check still counts as a real unavailable -> available transition
   * later, instead of looking like a first sighting.
   */
  rooms: RoomObservation[];
  /** Human-readable explanation, safe to log (never contains secrets). */
  reason: string;
  /** Which detection signals fired, for debugging a site change. */
  signals: string[];
}

/** How the page was fetched. */
export type TransportKind = 'http' | 'playwright';

/** Raw page returned by a transport. */
export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  transport: TransportKind;
  /** Milliseconds the fetch took. */
  durationMs: number;
}

/** A single monitoring condition from config/watch.json. */
export interface WatchCondition {
  id: string;
  /** Currently only "miracosta" is supported; the table lives in hotels.ts. */
  hotel: string;
  /** Check-in date, ISO "YYYY-MM-DD". */
  checkIn: string;
  nights: number;
  adults: number;
  children: number;
  /** Number of rooms to search for. Defaults to 1. */
  rooms: number;
  /**
   * All keywords must appear somewhere in the room text for it to match.
   * Empty array = every room in the hotel counts.
   */
  roomKeywords: string[];
  /** Optional plan keywords, same AND semantics. Usually empty. */
  planKeywords: string[];
  /** Set false to keep the condition in the file but stop checking it. */
  enabled: boolean;
}

/** Global settings from config/watch.json. */
export interface MonitorSettings {
  /** Normal gap between checks of the same watch, in minutes. */
  intervalMinutes: number;
  /** Random jitter added to each interval, in percent (load spreading only). */
  jitterPercent: number;
  /** Minimum seconds between any two outbound requests, across all watches. */
  minRequestSpacingSeconds: number;
  /** First backoff step, in minutes. Doubles on each consecutive failure. */
  backoffBaseMinutes: number;
  /** Ceiling for the backoff, in minutes. */
  backoffMaxMinutes: number;
  /** Notify if the very first check already shows availability. */
  notifyOnInitialAvailability: boolean;
  /** Warn over LINE when no successful check happened for this long. */
  staleAfterMinutes: number;
  /** Consecutive parser failures before declaring MONITOR_BROKEN. */
  parserErrorThreshold: number;
  /** Fetch strategy. "auto" = plain HTTP first, browser only if needed. */
  transport: 'auto' | 'http' | 'playwright';
  /** Honour robots.txt. Leave true. */
  respectRobotsTxt: boolean;
  /** Save sanitised HTML + screenshots when parsing fails. */
  saveDebugOnParserError: boolean;
}

export interface AppConfig {
  settings: MonitorSettings;
  watches: WatchCondition[];
}

/** Alert categories that are de-duplicated so we never spam LINE. */
export type AlertKind = 'captcha' | 'monitor_broken' | 'stale' | 'robots_blocked';
