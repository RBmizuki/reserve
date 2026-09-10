/**
 * The Disney hotels the official reservation site knows about.
 *
 * `code` is the value the official site uses for its `searchHotelCD` query
 * parameter. Only MiraCosta is exercised today; the others are listed because
 * the site uses the same page for all of them, so supporting them costs nothing.
 */
export interface HotelDefinition {
  /** Key used in config/watch.json ("hotel" field). */
  key: string;
  /** Official `searchHotelCD` value. */
  code: string;
  /** Japanese display name used in LINE notifications. */
  name: string;
  /** Official information page (a stable, public, non-session URL). */
  infoUrl: string;
}

export const HOTELS: readonly HotelDefinition[] = [
  {
    key: 'miracosta',
    code: 'DHM',
    name: '東京ディズニーシー・ホテルミラコスタ',
    infoUrl: 'https://www.tokyodisneyresort.jp/hotel/dhm.html',
  },
  {
    key: 'disneyland-hotel',
    code: 'TDH',
    name: '東京ディズニーランドホテル',
    infoUrl: 'https://www.tokyodisneyresort.jp/hotel/tdh.html',
  },
  {
    key: 'ambassador',
    code: 'DAH',
    name: 'ディズニーアンバサダーホテル',
    infoUrl: 'https://www.tokyodisneyresort.jp/hotel/dah.html',
  },
  {
    key: 'toystory',
    code: 'TSH',
    name: '東京ディズニーリゾート・トイ・ストーリーホテル',
    infoUrl: 'https://www.tokyodisneyresort.jp/hotel/tsh.html',
  },
  {
    key: 'fantasy-springs',
    code: 'FSH',
    name: '東京ディズニーシー・ファンタジースプリングスホテル',
    infoUrl: 'https://www.tokyodisneyresort.jp/hotel/fsh.html',
  },
] as const;

export function findHotel(key: string): HotelDefinition | undefined {
  const needle = key.trim().toLowerCase();
  return HOTELS.find((h) => h.key === needle || h.code.toLowerCase() === needle);
}

export function hotelKeys(): string[] {
  return HOTELS.map((h) => h.key);
}
