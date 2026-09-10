/** Shared test helpers. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '../src/config.js';
import type { MonitorSettings, RoomObservation, RoomOffer, WatchCondition } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8');
}

export const PARSE_OPTIONS = {
  hotelCode: 'DHM',
  hotelName: '東京ディズニーシー・ホテルミラコスタ',
  fallbackUrl: 'https://reserve.tokyodisneyresort.jp/hotel/search/',
};

export function makeWatch(overrides: Partial<WatchCondition> = {}): WatchCondition {
  return {
    id: 'miracosta-2026-11-20',
    hotel: 'miracosta',
    checkIn: '2026-11-20',
    nights: 1,
    adults: 2,
    children: 0,
    rooms: 1,
    roomKeywords: [],
    planKeywords: [],
    enabled: true,
    ...overrides,
  };
}

export function makeSettings(overrides: Partial<MonitorSettings> = {}): MonitorSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

export function makeOffer(overrides: Partial<RoomOffer> = {}): RoomOffer {
  return {
    roomKey: 'HOTDHMSPB0001N',
    officialRoomCode: 'HOTDHMSPB0001N',
    hotelCode: 'DHM',
    hotelName: '東京ディズニーシー・ホテルミラコスタ',
    roomName:
      'スペチアーレ・ルーム＆スイート ポルト・パラディーゾ・サイド バルコニールーム ハーバービュー',
    side: 'ポルト・パラディーゾ・サイド',
    view: 'ハーバービュー',
    planName: null,
    price: 128000,
    priceText: '¥128,000',
    url: 'https://reserve.tokyodisneyresort.jp/hotel/list/?hotelRoomCd=HOTDHMSPB0001N',
    ...overrides,
  };
}

/** Shorthand for building a parse-like result to feed the state machine. */
export function observations(
  ...entries: Array<[RoomOffer, 'available' | 'unavailable']>
): RoomObservation[] {
  return entries.map(([offer, state]) => ({ offer, state }));
}
