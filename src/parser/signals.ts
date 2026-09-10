/**
 * Text signals used to classify a search-result page.
 *
 * These lists are the part most likely to need updating if the official site
 * rewords something, so they live on their own and are covered by fixture
 * tests. Everything is matched against NFKC-normalised text, so half-width /
 * full-width differences do not matter.
 */

/** Normalises page text so matching is stable across width/spacing variants. */
export function normalizeText(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u3000\s]+/g, ' ')
    .trim();
}

/**
 * A CAPTCHA or bot-check interstitial. We never attempt to solve these — the
 * watch is suspended and the user is told.
 */
export const CAPTCHA_SIGNALS: readonly string[] = [
  'g-recaptcha',
  'recaptcha/api.js',
  'www.google.com/recaptcha',
  'hcaptcha.com',
  'cf-challenge',
  'cf_chl_opt',
  'Checking your browser before accessing',
  'Attention Required! | Cloudflare',
  '_Incapsula_Resource',
  'Request unsuccessful. Incapsula incident ID',
  'Access Denied',
  'You don’t have permission to access',
  'errors.edgesuite.net',
  'Reference #18.',
  'ロボットではないことを確認',
  'あなたがロボットではないこと',
  '自動化されたアクセス',
  '自動アクセスと判断',
  '不正なアクセスを検知',
  'アクセスが制限されています',
  'セキュリティ上の理由によりアクセスを制限',
];

/**
 * The site is up but telling us to come back later (queue / congestion /
 * maintenance). Treated like a network error: back off, do not conclude
 * anything about availability.
 */
export const BUSY_SIGNALS: readonly string[] = [
  'アクセスが集中',
  'アクセスが混み合',
  'ただいま大変混み合',
  'しばらく時間をおいて',
  'しばらくたってから',
  'ただいまメンテナンス',
  'メンテナンス中',
  'システムメンテナンス',
  'ただいまつながりにくく',
  '順番にご案内',
  '待機列',
];

/**
 * The site positively said there is nothing to book.
 * ONLY these turn a check into "unavailable".
 */
export const SOLD_OUT_SIGNALS: readonly string[] = [
  '空室がございません',
  '空室はございません',
  '空きがございません',
  '空室が見つかりません',
  'ご希望に添えるお部屋がございません',
  'ご希望に沿うお部屋がございません',
  'ご希望の条件に合うお部屋がございません',
  'ご希望の条件に一致する',
  '条件に一致するお部屋がありません',
  '該当するお部屋がございません',
  '該当するお部屋がありません',
  '該当する客室がございません',
  '該当するプランがございません',
  '予約可能なお部屋がございません',
  '予約可能な客室はありません',
  '検索結果は0件',
  '検索結果 0件',
  '満室のため',
  'すべて満室',
  '空室なし',
];

/**
 * The date is outside the booking window (Disney opens bookings 4 months
 * ahead). Not an error and not "sold out" in spirit, but for state-transition
 * purposes it behaves the same: nothing to book yet, and we want a notification
 * on the day it opens.
 */
export const OUT_OF_WINDOW_SIGNALS: readonly string[] = [
  '予約受付期間外',
  '予約受付期間前',
  'ご予約受付前',
  '受付開始前',
  '予約の受付を開始しておりません',
  '予約受付を終了',
  '受付を終了いたしました',
];

/** Per-room markers meaning "this particular room is not bookable". */
export const ROOM_SOLD_OUT_MARKERS: readonly string[] = [
  '満室',
  '空室なし',
  '×',
  '✕',
  '☓',
  '受付終了',
  '予約受付終了',
  '販売終了',
  '選択できません',
  'ご用意がございません',
  '設定がありません',
];

/** Per-room markers meaning "this particular room can be booked". */
export const ROOM_AVAILABLE_MARKERS: readonly string[] = [
  '空室あり',
  '残り',
  '予約する',
  'ご予約へ',
  'プランを選択',
  'お部屋を選択',
  '選択する',
  '空きあり',
  '○',
  '◎',
];

/** CSS class fragments that usually mean a disabled/sold-out entry. */
export const SOLD_OUT_CLASS_FRAGMENTS: readonly string[] = [
  'soldout',
  'sold-out',
  'sold_out',
  'novacancy',
  'no-vacancy',
  'is-disabled',
  'disabled',
  'unavailable',
  'full',
];

/** Matches Japanese price displays: "¥123,456" / "123,456円". */
export const PRICE_PATTERN = /(?:[¥￥]\s?([0-9][0-9,]{2,})|([0-9][0-9,]{2,})\s?円)/;

/** Returns the signals from `list` that appear in `haystack`. */
export function matchedSignals(haystack: string, list: readonly string[]): string[] {
  return list.filter((needle) => haystack.includes(needle));
}
