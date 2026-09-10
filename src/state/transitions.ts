/**
 * When does a check become a LINE notification?
 *
 * Exactly one rule, applied per room:
 *
 *     previous != available  AND  now == available   ->  notify
 *
 * Everything else (available -> available, available -> unavailable,
 * anything -> unknown) only updates state. That is what stops the monitor from
 * pinging every five minutes while a room stays open, while still re-notifying
 * if the room sells out and frees up again later.
 *
 * A failed check (network, parser, CAPTCHA) NEVER writes room state. Silence
 * from the site must not be recorded as "sold out", or the next successful
 * check would look like a fresh opening and produce a false alert.
 */
import { normalizeText } from '../parser/signals.js';
import type { Storage } from '../storage/sqlite.js';
import type {
  AvailabilityState,
  CheckOutcome,
  MonitorSettings,
  RoomObservation,
  RoomOffer,
  WatchCondition,
} from '../types.js';

/** Text we match a watch's keywords against. */
function offerHaystack(offer: RoomOffer): string {
  return normalizeText(
    [offer.roomName, offer.side, offer.view, offer.planName].filter(Boolean).join(' '),
  );
}

/**
 * True when an offer satisfies a watch's filters.
 *
 * Keywords are AND-ed: `["ポルト・パラディーゾ・サイド", "ハーバービュー"]` means
 * "Porto Paradiso side AND harbour view". An empty list matches every room in
 * the hotel, which is the "notify me about anything at MiraCosta" setting.
 */
export function matchesWatch(offer: RoomOffer, watch: WatchCondition): boolean {
  const haystack = offerHaystack(offer);
  const roomOk = watch.roomKeywords.every((kw) => haystack.includes(normalizeText(kw)));
  const planOk = watch.planKeywords.every((kw) => haystack.includes(normalizeText(kw)));
  return roomOk && planOk;
}

export interface RoomTransition {
  offer: RoomOffer;
  from: AvailabilityState | 'new';
  to: AvailabilityState;
  /** True when this transition should produce a LINE notification. */
  notify: boolean;
}

export interface TransitionResult {
  /** Overall state of the watch after this check. */
  watchState: AvailabilityState;
  /** Rooms that just became bookable and should be announced. */
  toNotify: RoomOffer[];
  /** Every room whose state moved, for the log. */
  transitions: RoomTransition[];
  /** Rooms matching the watch that are currently bookable. */
  matchedAvailable: number;
}

/** Outcomes for which we trust the page enough to write room state. */
function isConclusive(outcome: CheckOutcome): outcome is 'available' | 'unavailable' {
  return outcome === 'available' || outcome === 'unavailable';
}

/**
 * Applies one check result to stored room state and reports what to notify.
 *
 * @param nowIso Timestamp used for every write, so a single check is atomic in time.
 */
export function applyCheckResult(
  storage: Storage,
  watch: WatchCondition,
  settings: MonitorSettings,
  result: { outcome: CheckOutcome; rooms: RoomObservation[] },
  nowIso: string = new Date().toISOString(),
): TransitionResult {
  // Inconclusive check: the site told us nothing we can trust. Leave state alone.
  if (!isConclusive(result.outcome)) {
    return { watchState: 'unknown', toNotify: [], transitions: [], matchedAvailable: 0 };
  }

  const matching = result.rooms.filter((r) => matchesWatch(r.offer, watch));
  const transitions: RoomTransition[] = [];
  const toNotify: RoomOffer[] = [];
  const seen = new Set<string>();

  for (const observation of matching) {
    const { offer, state } = observation;
    seen.add(offer.roomKey);

    const previous = storage.getRoomState(watch.id, offer.roomKey);
    const from: AvailabilityState | 'new' = previous ? previous.state : 'new';
    const changed = from !== state;

    // Notify only on a genuine move into "available"...
    let notify = false;
    if (state === 'available') {
      if (from === 'new') notify = settings.notifyOnInitialAvailability;
      else if (from !== 'available') notify = true;
      // ...or when the room is still available but a previous send never got
      // through. Without this, a LINE outage would swallow the alert entirely,
      // because the next check would see available -> available.
      else notify = previous?.notifyPending === 1;
    }

    storage.setRoomState(watch.id, offer.roomKey, state, offer, nowIso, changed, notify);
    if (changed || notify) transitions.push({ offer, from, to: state, notify });
    if (notify) toNotify.push(offer);
  }

  // Rooms we knew about that the site no longer lists are sold out. This is
  // safe because we only get here on a conclusive parse.
  for (const known of storage.listRoomStates(watch.id)) {
    if (seen.has(known.roomKey)) continue;
    if (known.state === 'unavailable') continue;
    storage.setRoomState(watch.id, known.roomKey, 'unavailable', null, nowIso, true);
    transitions.push({
      offer: {
        roomKey: known.roomKey,
        officialRoomCode: null,
        hotelCode: watch.hotel,
        hotelName: '',
        roomName: known.roomName,
        side: known.side,
        view: known.view,
        planName: known.planName,
        price: known.price,
        priceText: null,
        url: known.url,
      },
      from: known.state,
      to: 'unavailable',
      notify: false,
    });
  }

  const matchedAvailable = matching.filter((r) => r.state === 'available').length;

  // A search that parsed cleanly but listed no room rows at all (the site said
  // "no availability" in prose) is a legitimate "unavailable" for the watch.
  const watchState: AvailabilityState = matchedAvailable > 0 ? 'available' : 'unavailable';

  return { watchState, toNotify, transitions, matchedAvailable };
}

/**
 * Backoff schedule for consecutive failures: base, 2x, 4x, 8x ... capped.
 * `consecutiveErrors` is 1 for the first failure.
 */
export function backoffMinutes(consecutiveErrors: number, settings: MonitorSettings): number {
  if (consecutiveErrors <= 0) return settings.intervalMinutes;
  const raw = settings.backoffBaseMinutes * 2 ** (consecutiveErrors - 1);
  return Math.min(raw, settings.backoffMaxMinutes);
}

/**
 * Milliseconds until the next check.
 *
 * Jitter is applied on success only, and exists purely so several watches do
 * not line up and hit the site in the same second.
 */
export function nextDelayMs(
  consecutiveErrors: number,
  settings: MonitorSettings,
  random: () => number = Math.random,
): number {
  if (consecutiveErrors > 0) {
    return backoffMinutes(consecutiveErrors, settings) * 60_000;
  }
  const base = settings.intervalMinutes * 60_000;
  const spread = (settings.jitterPercent / 100) * base;
  return Math.round(base + (random() * 2 - 1) * spread);
}
