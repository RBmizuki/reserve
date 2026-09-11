/**
 * LINE Messaging API client.
 *
 * Picks the cheapest endpoint that reaches everyone who should be told:
 *
 *   broadcast  -> every user who added the bot as a friend (no ids needed)
 *   multicast  -> several user ids in one request
 *   push       -> one user, group or room
 *
 * Only one request is made per notification in every normal case, so the LINE
 * message quota is consumed once per recipient rather than once per attempt.
 *
 * The channel access token is read from the environment, never logged, never
 * written to disk, and never included in an error message.
 */
import { invalidRecipients, readLineCredentials, type LineCredentials } from '../config.js';
import { logger } from '../logger.js';
import { describeError, isNetworkError } from '../redact.js';

const PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';
const MULTICAST_ENDPOINT = 'https://api.line.me/v2/bot/message/multicast';
const BROADCAST_ENDPOINT = 'https://api.line.me/v2/bot/message/broadcast';

/** LINE caps a multicast request at 500 recipients. */
const MULTICAST_BATCH = 500;

/** A single request this notifier will make. */
interface Delivery {
  endpoint: string;
  body: Record<string, unknown>;
  /** For logs and error messages: how many people this request reaches. */
  describe: string;
}

/**
 * Works out the minimum set of API calls needed.
 *
 * Group and room ids cannot go in a multicast request, so they always get
 * their own push call; plain user ids are batched into one multicast.
 */
export function planDeliveries(
  credentials: LineCredentials,
  messages: Array<Record<string, unknown>>,
): Delivery[] {
  if (credentials.broadcast) {
    return [{ endpoint: BROADCAST_ENDPOINT, body: { messages }, describe: 'all friends' }];
  }

  const userIds = credentials.recipients.filter((id) => id.startsWith('U'));
  const groupsAndRooms = credentials.recipients.filter((id) => !id.startsWith('U'));
  const deliveries: Delivery[] = [];

  if (userIds.length === 1) {
    deliveries.push({
      endpoint: PUSH_ENDPOINT,
      body: { to: userIds[0], messages },
      describe: '1 user',
    });
  } else if (userIds.length > 1) {
    for (let i = 0; i < userIds.length; i += MULTICAST_BATCH) {
      const batch = userIds.slice(i, i + MULTICAST_BATCH);
      deliveries.push({
        endpoint: MULTICAST_ENDPOINT,
        body: { to: batch, messages },
        describe: `${batch.length} users`,
      });
    }
  }

  for (const id of groupsAndRooms) {
    deliveries.push({
      endpoint: PUSH_ENDPOINT,
      body: { to: id, messages },
      describe: id.startsWith('C') ? 'a group chat' : 'a multi-person chat',
    });
  }

  return deliveries;
}

export interface SendResult {
  ok: boolean;
  /** Safe, already-redacted description of what went wrong. */
  error?: string;
  /** True when a retry later could plausibly succeed. */
  retryable?: boolean;
}

export interface LineSenderOptions {
  /** When true, messages are printed instead of sent. */
  dryRun?: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class LineNotifier {
  private readonly dryRun: boolean;
  private readonly maxAttempts: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: LineSenderOptions = {}) {
    this.dryRun = options.dryRun ?? false;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** True when LINE credentials are present in the environment. */
  static isConfigured(): boolean {
    return readLineCredentials() !== null;
  }

  /** Short description of who notifications go to, for `status` and `test-line`. */
  static describeRecipients(): string {
    const credentials = readLineCredentials();
    if (!credentials) return 'not configured';
    if (credentials.broadcast) {
      return 'broadcast — everyone who added the bot as a friend';
    }
    const users = credentials.recipients.filter((id) => id.startsWith('U')).length;
    const groups = credentials.recipients.length - users;
    const parts: string[] = [];
    if (users > 0) parts.push(users === 1 ? '1 person' : `${users} people`);
    if (groups > 0) parts.push(`${groups} group/room chat${groups === 1 ? '' : 's'}`);
    return parts.join(' + ');
  }

  /**
   * Sends one text message.
   *
   * Retries transient failures (network, 429, 5xx) with exponential backoff.
   * A 4xx other than 429 is permanent — usually a bad token or user id — and is
   * reported once rather than retried forever.
   */
  async send(text: string): Promise<SendResult> {
    if (this.dryRun) {
      process.stdout.write(`\n[DRY RUN]\n\nWould send LINE notification:\n\n${text}\n\n`);
      return { ok: true };
    }

    const credentials = readLineCredentials();
    if (!credentials) {
      return {
        ok: false,
        error:
          'LINE is not configured. Set LINE_CHANNEL_ACCESS_TOKEN and either ' +
          'LINE_BROADCAST=1 or LINE_TO in .env',
        retryable: false,
      };
    }

    const malformed = invalidRecipients(credentials.recipients);
    if (malformed.length > 0) {
      return {
        ok: false,
        error:
          `${malformed.length} recipient id(s) in .env are not valid LINE ids. ` +
          'A LINE id is one letter (U for a person, C for a group, R for a ' +
          'multi-person chat) followed by 32 hex characters.',
        retryable: false,
      };
    }

    const messages = [{ type: 'text', text }];
    const deliveries = planDeliveries(credentials, messages);
    if (deliveries.length === 0) {
      return { ok: false, error: 'No LINE recipients are configured', retryable: false };
    }

    const permanentFailures: string[] = [];
    const transientFailures: string[] = [];

    for (const delivery of deliveries) {
      const result = await this.deliver(delivery);
      if (result.ok) {
        logger.info('notification sent', { to: delivery.describe });
      } else if (result.retryable) {
        transientFailures.push(`${delivery.describe}: ${result.error ?? 'unknown'}`);
      } else {
        permanentFailures.push(`${delivery.describe}: ${result.error ?? 'unknown'}`);
      }
    }

    // A transient failure is worth retrying: a duplicate for the recipients who
    // did get it is much better than one of them never being told at all.
    if (transientFailures.length > 0) {
      return { ok: false, error: transientFailures.join('; '), retryable: true };
    }

    // A permanent failure will not fix itself (blocked bot, bad id). Report it
    // loudly, but do not hold the notification open — retrying forever would
    // just spam whoever the message *did* reach.
    if (permanentFailures.length > 0) {
      const failedAll = permanentFailures.length === deliveries.length;
      logger.error('Some LINE recipients could not be reached', {
        failed: permanentFailures.length,
        of: deliveries.length,
        detail: permanentFailures.join('; '),
      });
      if (failedAll) {
        return { ok: false, error: permanentFailures.join('; '), retryable: false };
      }
    }

    return { ok: true };
  }

  /** Performs one API call, with retries for transient failures. */
  private async deliver(delivery: Delivery): Promise<SendResult> {
    const credentials = readLineCredentials();
    if (!credentials) return { ok: false, error: 'LINE is not configured', retryable: false };

    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const response = await fetch(delivery.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credentials.channelAccessToken}`,
          },
          body: JSON.stringify(delivery.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.ok) return { ok: true };

        // Read the body for diagnostics, but only keep LINE's short message field.
        const detail = await this.safeErrorDetail(response);

        if (response.status === 429 || response.status >= 500) {
          lastError = `LINE API temporary failure (HTTP ${response.status}): ${detail}`;
          if (attempt < this.maxAttempts) {
            await this.sleep(1000 * 2 ** (attempt - 1));
            continue;
          }
          return { ok: false, error: lastError, retryable: true };
        }

        // 400/401/403: configuration problem. Retrying will not help.
        return {
          ok: false,
          error: `LINE API rejected the message (HTTP ${response.status}): ${detail}`,
          retryable: false,
        };
      } catch (err) {
        lastError = describeError(err);
        if (isNetworkError(err) && attempt < this.maxAttempts) {
          await this.sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        return { ok: false, error: lastError, retryable: isNetworkError(err) };
      }
    }
    return { ok: false, error: lastError, retryable: true };
  }

  /** Extracts LINE's `message` field without echoing anything else. */
  private async safeErrorDetail(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { message?: unknown };
      const message = typeof body.message === 'string' ? body.message : '';
      return message.slice(0, 200) || '(no detail)';
    } catch {
      return '(no detail)';
    }
  }
}
