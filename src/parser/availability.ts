/**
 * Turns a fetched search-result page into a {@link ParseResult}.
 *
 * The one rule that matters:
 *
 *   "unavailable" is only ever produced by a POSITIVELY RECOGNISED sold-out
 *   signal. Anything we do not understand becomes "parser_error", which the
 *   monitor maps to the `unknown` state. A site redesign must never look like
 *   "the hotel is full".
 */
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import {
  BUSY_SIGNALS,
  CAPTCHA_SIGNALS,
  matchedSignals,
  normalizeText,
  OUT_OF_WINDOW_SIGNALS,
  PRICE_PATTERN,
  ROOM_AVAILABLE_MARKERS,
  ROOM_SOLD_OUT_MARKERS,
  SOLD_OUT_CLASS_FRAGMENTS,
  SOLD_OUT_SIGNALS,
} from './signals.js';
import { RESERVE_ORIGIN } from '../checker/url.js';
import type { ParseResult, RoomObservation, RoomOffer } from '../types.js';

/** Known MiraCosta building/side names, used to split a room label for display. */
const SIDE_TOKENS = [
  'スペチアーレ・ルーム＆スイート',
  'ポルト・パラディーゾ・サイド',
  'ヴェネツィア・サイド',
  'トスカーナ・サイド',
];

/** Known view names across the Disney hotels. */
const VIEW_TOKENS = [
  'ハーバーグランドビュー',
  'ハーバービュー',
  'パルテールグランドビュー',
  'パルテールビュー',
  'ピアッツァグランドビュー',
  'ピアッツァビュー',
  'カナルビュー',
  'ソットマリーノ・ビュー',
  'パークグランドビュー',
  'パークビュー',
  'ガーデンビュー',
  'マーメイドラグーン',
];

export interface ParseOptions {
  hotelCode: string;
  hotelName: string;
  /** Fallback link used when a room row has no usable public URL of its own. */
  fallbackUrl: string;
}

function stableKey(parts: Array<string | null>): string {
  const joined = parts.map((p) => p ?? '').join('|');
  return createHash('sha1').update(joined).digest('hex').slice(0, 16);
}

function findToken(text: string, tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (text.includes(token)) return token;
  }
  return null;
}

function parsePrice(text: string): { price: number | null; priceText: string | null } {
  const m = PRICE_PATTERN.exec(text);
  if (!m) return { price: null, priceText: null };
  const digits = (m[1] ?? m[2] ?? '').replace(/,/g, '');
  const value = Number.parseInt(digits, 10);
  if (!Number.isFinite(value) || value <= 0) return { price: null, priceText: null };
  return { price: value, priceText: `¥${value.toLocaleString('ja-JP')}` };
}

/** Query-parameter names that would make a URL unsafe to store or send. */
const CREDENTIAL_PARAM =
  /^(jsessionid|session|sessionid|session_id|sessiontoken|token|access_token|accesstoken|auth|authorization|sig|signature|sid|key|apikey|api_key|password|pwd)$/i;

function absoluteUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, RESERVE_ORIGIN);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // Never hand out a URL that carries credentials. Matched on the whole
    // parameter name so ordinary site flags such as `removeSessionFlg` — which
    // the official search URL always carries — are not mistaken for secrets.
    for (const key of [...url.searchParams.keys()]) {
      if (CREDENTIAL_PARAM.test(key)) return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** Extracts `hotelRoomCd` from a URL-ish string, if present. */
export function extractRoomCode(href: string): string | null {
  const m = /[?&]hotelRoomCd=([A-Za-z0-9_-]+)/.exec(href);
  return m?.[1] ?? null;
}

type RoomVerdict = 'available' | 'sold_out' | 'ambiguous';

interface RoomCandidate {
  code: string | null;
  text: string;
  html: string;
  href: string | null;
}

/**
 * Classifies one room row.
 *
 * Sold-out wins over available: a row that shows both a price and a "満室"
 * badge is not bookable (the price is just the rack rate).
 */
function classifyRoom(candidate: RoomCandidate, classNames: string): RoomVerdict {
  const text = candidate.text;

  if (matchedSignals(text, ROOM_SOLD_OUT_MARKERS).length > 0) return 'sold_out';

  const lowerClasses = classNames.toLowerCase();
  if (SOLD_OUT_CLASS_FRAGMENTS.some((fragment) => lowerClasses.includes(fragment))) {
    return 'sold_out';
  }

  const hasPrice = PRICE_PATTERN.test(text);
  const hasAvailableMarker = matchedSignals(text, ROOM_AVAILABLE_MARKERS).length > 0;
  if (hasPrice || hasAvailableMarker) return 'available';

  return 'ambiguous';
}

/** Walks up from a room link to the element that represents the whole row. */
function rowContainer($: cheerio.CheerioAPI, node: AnyNode): cheerio.Cheerio<AnyNode> {
  let current = $(node);
  for (let depth = 0; depth < 6; depth++) {
    const parent = current.parent();
    if (parent.length === 0) break;
    const tag = (parent.get(0) as { tagName?: string } | undefined)?.tagName?.toLowerCase() ?? '';
    if (tag === 'body' || tag === 'html') break;
    current = parent;
    const cls = (current.attr('class') ?? '').toLowerCase();
    if (
      tag === 'li' ||
      tag === 'tr' ||
      tag === 'article' ||
      /room|item|card|plan|result/.test(cls)
    ) {
      // Keep climbing only if the row is suspiciously small (an inner wrapper).
      if (current.text().trim().length >= 12) return current;
    }
  }
  return current;
}

function buildOffer(candidate: RoomCandidate, options: ParseOptions, nameHint: string): RoomOffer {
  const roomName = normalizeText(nameHint).slice(0, 120) || '(room name unavailable)';
  const side = findToken(roomName, SIDE_TOKENS);
  const view = findToken(roomName, VIEW_TOKENS);
  const { price, priceText } = parsePrice(candidate.text);
  const url = absoluteUrl(candidate.href ?? undefined) ?? options.fallbackUrl;

  return {
    roomKey: candidate.code ?? stableKey([options.hotelCode, roomName, side, view, null]),
    officialRoomCode: candidate.code,
    hotelCode: options.hotelCode,
    hotelName: options.hotelName,
    roomName,
    side,
    view,
    planName: null,
    price,
    priceText,
    url,
  };
}

/**
 * Collects room rows anchored on the official `hotelRoomCd` parameter.
 * This is the most reliable structural anchor the site gives us: the room code
 * appears in the room's own link and is stable across page redesigns.
 */
function collectByRoomCode(
  $: cheerio.CheerioAPI,
  options: ParseOptions,
): {
  offers: RoomOffer[];
  rooms: RoomObservation[];
  soldOut: number;
  ambiguous: number;
  total: number;
} {
  const seen = new Map<string, { verdict: RoomVerdict; offer: RoomOffer }>();

  $('a[href*="hotelRoomCd="]').each((_, element) => {
    const href = $(element).attr('href') ?? '';
    const code = extractRoomCode(href);
    if (!code) return;

    const container = rowContainer($, element);
    const text = normalizeText(container.text());
    const candidate: RoomCandidate = {
      code,
      text,
      html: container.html() ?? '',
      href,
    };
    const verdict = classifyRoom(candidate, container.attr('class') ?? '');
    const linkText = normalizeText($(element).text());
    const nameHint = linkText.length >= 3 ? linkText : text.slice(0, 120);
    const offer = buildOffer(candidate, options, nameHint);

    // A room can appear more than once (e.g. one link per plan). Keep the most
    // optimistic verdict, because one bookable plan means the room is bookable.
    const previous = seen.get(code);
    if (!previous || (previous.verdict !== 'available' && verdict === 'available')) {
      seen.set(code, { verdict, offer });
    }
  });

  const offers: RoomOffer[] = [];
  const rooms: RoomObservation[] = [];
  let soldOut = 0;
  let ambiguous = 0;
  for (const { verdict, offer } of seen.values()) {
    if (verdict === 'available') {
      offers.push(offer);
      rooms.push({ offer, state: 'available' });
    } else if (verdict === 'sold_out') {
      soldOut += 1;
      rooms.push({ offer, state: 'unavailable' });
    } else {
      ambiguous += 1;
    }
  }
  return { offers, rooms, soldOut, ambiguous, total: seen.size };
}

/**
 * Fallback collector for pages that list rooms without a `hotelRoomCd` link
 * (for instance a redesigned card layout). Anchored on price text instead.
 */
function collectByPricedRows($: cheerio.CheerioAPI, options: ParseOptions): RoomOffer[] {
  const offers = new Map<string, RoomOffer>();

  $('li, tr, article, section, div').each((_, element) => {
    const node = $(element);
    // Only leaf-ish rows: skip wrappers that contain other candidate rows.
    if (node.find('li, tr, article').length > 0) return;
    const text = normalizeText(node.text());
    if (text.length < 8 || text.length > 400) return;
    if (!PRICE_PATTERN.test(text)) return;
    if (matchedSignals(text, ROOM_SOLD_OUT_MARKERS).length > 0) return;

    const classNames = (node.attr('class') ?? '').toLowerCase();
    if (SOLD_OUT_CLASS_FRAGMENTS.some((f) => classNames.includes(f))) return;

    // Require something that looks like a Disney room label, so we do not pick
    // up unrelated priced content (tickets, merchandise banners...).
    const looksLikeRoom =
      findToken(text, SIDE_TOKENS) !== null ||
      findToken(text, VIEW_TOKENS) !== null ||
      /ルーム|客室|お部屋|スイート|ハーバー/.test(text);
    if (!looksLikeRoom) return;

    const href = node.find('a[href]').first().attr('href') ?? null;
    const candidate: RoomCandidate = { code: null, text, html: node.html() ?? '', href };
    const offer = buildOffer(candidate, options, text.slice(0, 120));
    if (!offers.has(offer.roomKey)) offers.set(offer.roomKey, offer);
  });

  return [...offers.values()];
}

/**
 * Parses a search-result page.
 *
 * @param body  The raw response body (HTML, or JSON if the site returns it).
 */
export function parseAvailability(body: string, options: ParseOptions): ParseResult {
  const signals: string[] = [];

  if (!body || body.trim().length === 0) {
    return {
      outcome: 'parser_error',
      offers: [],
      rooms: [],
      reason: 'Empty response body',
      signals,
    };
  }

  const normalizedBody = normalizeText(body);

  // 1. Bot-check / CAPTCHA. Checked first and never worked around.
  const captcha = matchedSignals(normalizedBody, CAPTCHA_SIGNALS);
  if (captcha.length > 0) {
    return {
      outcome: 'captcha',
      offers: [],
      rooms: [],
      reason: `Bot-check or access-restriction page detected (${captcha[0]})`,
      signals: captcha.map((s) => `captcha:${s}`),
    };
  }

  const $ = cheerio.load(body);
  // Script/style text would otherwise pollute every text match.
  $('script, style, noscript').remove();
  const visibleText = normalizeText($('body').length > 0 ? $('body').text() : $.root().text());

  // 2. Congestion / maintenance: the site is asking us to come back later.
  const busy = matchedSignals(visibleText, BUSY_SIGNALS);
  if (busy.length > 0) {
    return {
      outcome: 'network_error',
      offers: [],
      rooms: [],
      reason: `Site is busy or under maintenance (${busy[0]})`,
      signals: busy.map((s) => `busy:${s}`),
    };
  }

  // 3. Room rows, anchored on the official room code.
  const byCode = collectByRoomCode($, options);
  if (byCode.total > 0) {
    signals.push(`rooms:byRoomCode=${byCode.total}`);
    if (byCode.offers.length > 0) {
      return {
        outcome: 'available',
        offers: byCode.offers,
        rooms: byCode.rooms,
        reason: `${byCode.offers.length} of ${byCode.total} room rows are bookable`,
        signals,
      };
    }
    if (byCode.ambiguous === 0) {
      return {
        outcome: 'unavailable',
        offers: [],
        rooms: byCode.rooms,
        reason: `All ${byCode.total} room rows are marked sold out`,
        signals: [...signals, 'soldout:allRoomsMarked'],
      };
    }
    // Some rows we could not read: refuse to call it sold out.
    return {
      outcome: 'parser_error',
      offers: [],
      rooms: [],
      reason:
        `${byCode.ambiguous} of ${byCode.total} room rows could not be classified ` +
        `as available or sold out`,
      signals: [...signals, `ambiguous:${byCode.ambiguous}`],
    };
  }

  // 4. No room codes at all. Look for an explicit "nothing available" message.
  const soldOut = matchedSignals(visibleText, SOLD_OUT_SIGNALS);
  if (soldOut.length > 0) {
    return {
      outcome: 'unavailable',
      offers: [],
      rooms: [],
      reason: `Site reported no availability (${soldOut[0]})`,
      signals: soldOut.map((s) => `soldout:${s}`),
    };
  }

  const outOfWindow = matchedSignals(visibleText, OUT_OF_WINDOW_SIGNALS);
  if (outOfWindow.length > 0) {
    return {
      outcome: 'unavailable',
      offers: [],
      rooms: [],
      reason: `Date is outside the booking window (${outOfWindow[0]})`,
      signals: outOfWindow.map((s) => `window:${s}`),
    };
  }

  // 5. Last resort: priced room-looking rows in an unfamiliar layout.
  const priced = collectByPricedRows($, options);
  if (priced.length > 0) {
    return {
      outcome: 'available',
      offers: priced,
      rooms: priced.map((offer) => ({ offer, state: 'available' as const })),
      reason: `${priced.length} priced room rows found without official room codes`,
      signals: ['rooms:byPrice'],
    };
  }

  // 6. We genuinely do not know. This is NOT "sold out".
  return {
    outcome: 'parser_error',
    offers: [],
    rooms: [],
    reason:
      'Page did not contain room rows, a sold-out message, or any recognised marker ' +
      `(${visibleText.length} chars of visible text)`,
    signals: ['unrecognised'],
  };
}
