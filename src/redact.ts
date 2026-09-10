/**
 * Secret scrubbing.
 *
 * Everything that can reach a log file, the console, a debug dump or a LINE
 * message goes through here first. The rules are deliberately blunt: it is far
 * better to over-redact a log line than to leak a channel access token.
 */

/** Patterns that must never appear in output, regardless of where they came from. */
const PATTERNS: Array<[RegExp, string]> = [
  // LINE channel access tokens are long base64-ish strings; also covers JWT-style v2.1 tokens.
  [/\b[A-Za-z0-9+/]{80,}={0,2}\b/g, '[REDACTED_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  // LINE user ids: "U" + 32 hex chars.
  [/\bU[0-9a-f]{32}\b/g, '[REDACTED_LINE_USER_ID]'],
  // Header-ish and key=value shapes. These consume the rest of the line: an
  // "Authorization: Bearer <token>" header must not leave the token behind
  // just because "Bearer" happened to be the first whitespace-delimited word.
  [/(authorization\s*[:=]\s*)([^\n\r]+)/gi, '$1[REDACTED]'],
  [/(bearer\s+)([^\s\n\r]+)/gi, '$1[REDACTED]'],
  [/(cookie\s*[:=]\s*)([^\n\r]+)/gi, '$1[REDACTED]'],
  [/(set-cookie\s*[:=]\s*)([^\n\r]+)/gi, '$1[REDACTED]'],
  [
    /((?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?token|session[_-]?id)"?\s*[:=]\s*"?)([^\s",;}]+)/gi,
    '$1[REDACTED]',
  ],
];

/**
 * Values pulled from the environment at call time. Kept dynamic so that a
 * token loaded after module init is still scrubbed.
 */
function liveSecrets(): string[] {
  const out: string[] = [];
  for (const key of ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_USER_ID']) {
    const value = process.env[key];
    // Ignore very short values: redacting them would mangle unrelated text.
    if (value && value.trim().length >= 8) out.push(value.trim());
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Removes secrets from a string. Always call this before writing anywhere. */
export function redact(input: string): string {
  let out = input;
  for (const secret of liveSecrets()) {
    out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Turns an unknown thrown value into a short, safe, single-line message.
 *
 * Never stringify an error object wholesale: fetch/undici errors can carry
 * request headers (including Authorization) on `cause`.
 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    const base = code ? `${err.name} [${code}]: ${err.message}` : `${err.name}: ${err.message}`;
    return redact(base).replace(/\s+/g, ' ').trim();
  }
  if (typeof err === 'string') return redact(err).slice(0, 500);
  return `Non-Error thrown (${typeof err})`;
}

/** True when the error looks like a transient network/DNS/timeout problem. */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code ?? '';
  const networkCodes = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENETDOWN',
    'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
    'ABORT_ERR',
  ]);
  if (networkCodes.has(code)) return true;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('socket hang up')
  );
}
