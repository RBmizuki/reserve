/**
 * Builds the official public search URL.
 *
 * This is the ordinary, publicly linkable GET URL that the official
 * reservation site itself uses for its hotel search results — the same address
 * a guest lands on after filling in the search form, and the same shape that
 * search engines have indexed. It carries no session token, no signature and
 * no authentication, so it is safe both to request and to put in a LINE
 * message.
 */
import { findHotel, type HotelDefinition } from './hotels.js';
import type { WatchCondition } from '../types.js';

export const RESERVE_ORIGIN = 'https://reserve.tokyodisneyresort.jp';
export const SEARCH_PATH = '/hotel/list/';
/** The human-facing search form, used as a fallback link in notifications. */
export const SEARCH_FORM_URL = `${RESERVE_ORIGIN}/hotel/search/`;

/** "2026-11-20" -> "20261120" (the site's `useDate` format). */
export function toUseDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!m) throw new Error(`checkIn must be YYYY-MM-DD, got: ${isoDate}`);
  return `${m[1]}${m[2]}${m[3]}`;
}

/** "20261120" -> "2026/11/20" for display. */
export function formatDateForDisplay(isoDate: string): string {
  return isoDate.replace(/-/g, '/');
}

/** Adds `nights` days to an ISO date, returning an ISO date. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function resolveHotel(watch: WatchCondition): HotelDefinition {
  const hotel = findHotel(watch.hotel);
  if (!hotel) throw new Error(`Unknown hotel "${watch.hotel}" in watch "${watch.id}"`);
  return hotel;
}

/**
 * Builds the search-results URL for one watch condition.
 *
 * The parameter set mirrors what the official site sends for its own search;
 * empty parameters are included because the site's server-side form binding
 * expects them to be present.
 */
export function buildSearchUrl(watch: WatchCondition): string {
  const hotel = resolveHotel(watch);
  const params = new URLSearchParams({
    showWay: '',
    roomsNum: String(watch.rooms),
    adultNum: String(watch.adults),
    childNum: String(watch.children),
    stayingDays: String(watch.nights),
    useDate: toUseDate(watch.checkIn),
    cpListStr: '',
    childAgeBedInform: '',
    searchHotelCD: hotel.code,
    searchHotelDiv: '',
    hotelName: '',
    searchHotelName: '',
    searchLayer: '',
    // We deliberately do NOT pre-filter by room name: we fetch the whole hotel
    // in one request and filter locally. That is one request instead of many.
    searchRoomName: '',
    hotelSearchDetail: 'true',
    detailOpenFlg: '0',
    checkPointStr: '',
    hotelChangeFlg: 'false',
    removeSessionFlg: 'true',
    returnFlg: 'false',
    hotelShowFlg: '',
    displayType: 'data-hotel',
    reservationStatus: '1',
  });
  return `${RESERVE_ORIGIN}${SEARCH_PATH}?${params.toString()}`;
}

/**
 * The URL we put in the LINE notification.
 *
 * Same public search URL as above: tapping it opens the official results for
 * exactly the searched date and party size, ready for the user to book by hand.
 */
export function buildBookingLink(watch: WatchCondition): string {
  return buildSearchUrl(watch);
}
