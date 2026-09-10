/**
 * LINE message templates.
 *
 * Kept as pure string builders so they can be unit tested and previewed with
 * `--dry-run` without touching the network.
 */
import { buildBookingLink } from '../checker/url.js';
import { findHotel } from '../checker/hotels.js';
import { timestamp } from '../logger.js';
import type { RoomOffer, WatchCondition } from '../types.js';

/** LINE rejects a text message longer than this. */
export const MAX_MESSAGE_LENGTH = 4900;
/** At most this many rooms are listed in one notification. */
const MAX_ROOMS_LISTED = 5;

function formatDate(isoDate: string): string {
  return isoDate.replace(/-/g, '/');
}

function formatParty(watch: WatchCondition): string {
  const parts = [`大人${watch.adults}名`];
  if (watch.children > 0) parts.push(`子ども${watch.children}名`);
  return parts.join(' ');
}

function hotelName(watch: WatchCondition): string {
  return findHotel(watch.hotel)?.name ?? watch.hotel;
}

/** Room name plus the side/view lines, one per line, without repeating them. */
function describeRoom(offer: RoomOffer): string {
  const lines: string[] = [];
  const name = offer.roomName.trim();
  if (name) lines.push(name);
  if (offer.side && !name.includes(offer.side)) lines.push(offer.side);
  if (offer.view && !name.includes(offer.view)) lines.push(offer.view);
  if (offer.planName) lines.push(`プラン: ${offer.planName}`);
  if (offer.priceText) lines.push(`料金: ${offer.priceText}`);
  return lines.join('\n');
}

/** Truncates to LINE's limit without cutting a line in half. */
function clamp(message: string): string {
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_MESSAGE_LENGTH - 20).trimEnd()}\n…(以下省略)`;
}

/**
 * The main event: one or more rooms just became bookable.
 *
 * The URL is the official public search page for exactly these dates and party
 * size — no session token, no expiry — so tapping it goes straight to the real
 * booking flow where the user books by hand.
 */
export function availabilityMessage(
  watch: WatchCondition,
  offers: RoomOffer[],
  now: Date = new Date(),
): string {
  const shown = offers.slice(0, MAX_ROOMS_LISTED);
  const roomBlock = shown.map(describeRoom).join('\n\n');
  const extra = offers.length > shown.length ? `\n\n他 ${offers.length - shown.length} 件` : '';

  return clamp(
    [
      '🏰 ミラコスタ空室発見！',
      '',
      'ホテル：',
      hotelName(watch),
      '',
      '宿泊日：',
      formatDate(watch.checkIn),
      '',
      '泊数：',
      `${watch.nights}泊`,
      '',
      '人数：',
      formatParty(watch),
      '',
      '部屋：',
      `${roomBlock}${extra}`,
      '',
      '確認日時：',
      timestamp(now).slice(0, 16).replace(/-/g, '/'),
      '',
      '予約ページ：',
      buildBookingLink(watch),
      '',
      `(監視条件: ${watch.id})`,
    ].join('\n'),
  );
}

/** A CAPTCHA or access-restriction page was shown. We never try to get past it. */
export function captchaMessage(watchId: string): string {
  return [
    '⚠️ ミラコスタ監視停止',
    '',
    '公式サイト側でCAPTCHAまたはアクセス確認画面を検出しました。',
    '',
    '自動突破は行っていません。',
    '',
    '手動確認後、監視を再開してください。',
    '',
    `対象: ${watchId}`,
    '',
    '再開コマンド：',
    'npm run restart-service',
  ].join('\n');
}

/** The page stopped making sense: availability judgement is suspended. */
export function monitorBrokenMessage(watchId: string, reason: string): string {
  return [
    '⚠️ ミラコスタ監視システム異常',
    '',
    '公式予約サイトの構造が変更された可能性があります。',
    '',
    '空室判定を安全に停止しました。',
    '（満室と誤判定はしていません）',
    '',
    `対象: ${watchId}`,
    `内容: ${reason.slice(0, 200)}`,
    '',
    'debug/ フォルダに解析用の情報を保存しています。',
  ].join('\n');
}

/** No successful check for too long — the dangerous "running but blind" case. */
export function staleMessage(lastSuccess: Date | null, minutes: number): string {
  return [
    '⚠️ ミラコスタ監視異常',
    '',
    `最後に正常確認できてから${minutes}分以上経過しています。`,
    '',
    'Last successful check:',
    lastSuccess ? timestamp(lastSuccess).slice(0, 16).replace(/-/g, '/') : '(まだ一度もありません)',
    '',
    '監視システムを確認してください。',
    '',
    '状態確認コマンド：',
    'npm run status',
  ].join('\n');
}

/** Checks are succeeding again after a failure period. */
export function recoveryMessage(): string {
  return ['✅ ミラコスタ監視復旧', '', '空室確認が正常に戻りました。'].join('\n');
}

/** Sent by `npm run test-line`. */
export function testMessage(): string {
  return ['🏰 Miracosta Monitor', '', 'LINE通知テスト成功'].join('\n');
}
