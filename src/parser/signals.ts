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
 * Technical markers of a CAPTCHA or bot-check interstitial.
 *
 * These are machinery, not prose: a normal search-result page has no reason to
 * contain them, so finding one anywhere is decisive. We never attempt to solve
 * these — the watch is suspended and the user is told.
 */
export const CAPTCHA_STRONG_SIGNALS: readonly string[] = [
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
  'errors.edgesuite.net',
  'Reference #18.',
];

/**
 * Wording that *describes* an access restriction.
 *
 * Unlike the markers above, this is ordinary prose that could plausibly appear
 * in a help link or a notice on a perfectly working page, so it is only trusted
 * when the page contains no room rows at all.
 */
export const CAPTCHA_WEAK_SIGNALS: readonly string[] = [
  'Access Denied',
  'You don’t have permission to access',
  'ロボットではないことを確認',
  'あなたがロボットではないこと',
  '自動化されたアクセス',
  '自動アクセスと判断',
  '不正なアクセスを検知',
  'アクセスが制限されています',
  'セキュリティ上の理由によりアクセスを制限',
];

/**
 * The official site is holding visitors in a virtual waiting room
 * ("ただいまサイトが混雑しております / 順番にご案内します").
 *
 * We report this and back off. We deliberately do NOT wait in the queue: a
 * monitor sitting in line would take a place ahead of a real guest trying to
 * book, and the whole point of the queue is to shed load. Trying again later is
 * both politer and, at a ten-minute interval, perfectly effective.
 */
export const QUEUE_SIGNALS: readonly string[] = [
  'サイトが混雑しております',
  'ただいまサイトが混雑',
  '混雑しております',
  'アクセスが集中',
  'アクセスが混み合',
  'ただいま大変混み合',
  'ただいまつながりにくく',
  '順番にご案内',
  'お客様の順番になると',
  '待ち時間の目安',
  'アクセスできる推定時刻',
  '待機列',
];

/**
 * The site is closed for maintenance (published as 03:00-05:00 JST).
 *
 * Like every other phrase list, these are only trusted on a page that shows no
 * rooms at all. The waiting-room page itself carries the sentence "午前3時〜午前
 * 5時は、システムメンテナンスのため…" as a note, so matching maintenance wording
 * anywhere would mislabel a queue as an outage.
 */
export const MAINTENANCE_SIGNALS: readonly string[] = [
  'ただいまメンテナンス',
  'メンテナンス中',
  'システムメンテナンスのため',
  'システムメンテナンス',
  'しばらく時間をおいて',
  'しばらくたってから',
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

/**
 * URL path of the official maintenance page. Landing here (after redirects) is
 * unambiguous, unlike a phrase that might merely be announcing future downtime.
 */
export const MAINTENANCE_PATH = /\/error\/maintenance/i;
