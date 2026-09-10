/**
 * LINE Messaging API push client.
 *
 * Only the push endpoint is used, and only to the configured user id.
 * The channel access token is read from the environment, never logged, never
 * written to disk, and never included in an error message.
 */
import { readLineCredentials } from '../config.js';
import { logger } from '../logger.js';
import { describeError, isNetworkError } from '../redact.js';

const PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

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
        error: 'LINE_CHANNEL_ACCESS_TOKEN / LINE_USER_ID are not set in .env',
        retryable: false,
      };
    }

    let lastError = 'unknown error';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const response = await fetch(PUSH_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${credentials.channelAccessToken}`,
          },
          body: JSON.stringify({
            to: credentials.userId,
            messages: [{ type: 'text', text }],
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.ok) {
          logger.info('notification sent');
          return { ok: true };
        }

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
