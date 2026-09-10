/**
 * Prepares a page for the debug/ folder.
 *
 * Debug dumps exist to diagnose a site redesign, so we keep structure and
 * Japanese text but throw away anything that could carry credentials or
 * personal data.
 */
import * as cheerio from 'cheerio';
import { redact } from '../redact.js';

/** How much HTML we keep. Enough to see the layout, small enough to read. */
export const MAX_DEBUG_HTML_BYTES = 512 * 1024;

/** Attribute names that are secrets by their very name. */
const SECRET_ATTRIBUTE_NAME =
  /token|session|auth|cookie|csrf|nonce|signature|password|secret|jsessionid/i;

/** Attributes whose value is a URL. */
const URL_ATTRIBUTE = /^(href|src|action|formaction|data-url|data-href|content-url)$/i;

/** `foo=bar` shapes where `foo` is a credential name. */
const SECRET_ASSIGNMENT =
  /(?:token|session|jsessionid|auth|sig|signature|password|passwd|secret|api[_-]?key)\s*=\s*[^&\s"']+/i;

/** Query parameter names dropped from any URL we keep. */
const CREDENTIAL_PARAM =
  /^(jsessionid|session|sessionid|session_id|sessiontoken|token|access_token|accesstoken|auth|authorization|sig|signature|sid|key|apikey|api_key|password|pwd)$/i;

/**
 * Removes credential query parameters from a URL, keeping everything else.
 * Non-URL values are returned unchanged.
 */
function stripCredentialParams(value: string): string {
  if (!value || value.startsWith('data:') || value.startsWith('#')) return value;
  try {
    // A base is required for relative URLs; it is stripped again below.
    const base = 'https://placeholder.invalid';
    const url = new URL(value, base);
    let touched = false;
    for (const key of [...url.searchParams.keys()]) {
      if (CREDENTIAL_PARAM.test(key)) {
        url.searchParams.set(key, '[REDACTED]');
        touched = true;
      }
    }
    if (!touched) return value;
    return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch {
    // Not parseable as a URL: fall back to blanking anything secret-looking.
    return SECRET_ASSIGNMENT.test(value) ? '[REDACTED]' : value;
  }
}

/**
 * Strips scripts, styles, inline event handlers, form values, and any
 * attribute that might carry a token or session id, then redacts what is left.
 */
export function sanitizeHtml(html: string): string {
  const $ = cheerio.load(html);

  // Executable and tracking content: no diagnostic value, real leak potential.
  $('script, style, noscript, iframe, svg, canvas, link[rel="preload"]').remove();

  $('*').each((_, element) => {
    const node = $(element);
    const attribs = (element as { attribs?: Record<string, string> }).attribs ?? {};
    for (const name of Object.keys(attribs)) {
      const lower = name.toLowerCase();
      // Inline JS handlers.
      if (lower.startsWith('on')) {
        node.removeAttr(name);
        continue;
      }
      // Anything whose *name* smells of secrets.
      if (SECRET_ATTRIBUTE_NAME.test(lower)) {
        node.attr(name, '[REDACTED]');
        continue;
      }
      const value = attribs[name] ?? '';
      // URLs get their credential-bearing query parameters stripped rather than
      // being blanked out: the rest of the URL (the room code, the search
      // parameters) is exactly what makes a debug dump worth keeping.
      if (URL_ATTRIBUTE.test(lower)) {
        const cleaned = stripCredentialParams(value);
        if (cleaned !== value) node.attr(name, cleaned);
        continue;
      }
      // Anything whose *value* looks like an explicit secret assignment.
      if (SECRET_ASSIGNMENT.test(value)) node.attr(name, '[REDACTED]');
    }
  });

  // Never persist what was typed into a form.
  $('input').each((_, element) => {
    const node = $(element);
    const type = (node.attr('type') ?? '').toLowerCase();
    if (type === 'password' || type === 'hidden') {
      node.attr('value', '[REDACTED]');
    } else if (node.attr('value')) {
      node.attr('value', '[REDACTED_VALUE]');
    }
  });
  $('textarea').text('[REDACTED]');

  // Meta tags frequently carry CSRF tokens.
  $('meta').each((_, element) => {
    const node = $(element);
    const name = (node.attr('name') ?? node.attr('property') ?? '').toLowerCase();
    if (/token|csrf|session|auth/i.test(name)) node.attr('content', '[REDACTED]');
  });

  const output = redact($.html());
  return output.length > MAX_DEBUG_HTML_BYTES
    ? `${output.slice(0, MAX_DEBUG_HTML_BYTES)}\n<!-- truncated for size -->`
    : output;
}
