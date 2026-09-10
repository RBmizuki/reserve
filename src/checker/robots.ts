/**
 * Minimal robots.txt client.
 *
 * We fetch the official robots.txt, cache it, and refuse to check any URL it
 * disallows. If robots.txt cannot be fetched we fail *open* only for transient
 * errors (a 5xx/timeout) and fail *closed* on an explicit 401/403, matching the
 * usual convention. Crawl-delay, when present, raises our request spacing.
 */
import { logger } from '../logger.js';
import { describeError } from '../redact.js';

export interface RobotsRules {
  /** Path rules that apply to us, most specific first. */
  rules: Array<{ allow: boolean; pattern: string }>;
  /** Crawl-delay in seconds, if the site declares one for our agent. */
  crawlDelaySeconds: number | null;
  /** True when we could not read robots.txt and are proceeding anyway. */
  assumedAllowed: boolean;
  fetchedAt: number;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const cache = new Map<string, RobotsRules>();

/** Converts a robots.txt path pattern into a regular expression. */
function patternToRegExp(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '$') source += '$';
    else source += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}`);
}

/**
 * Parses robots.txt, keeping only the groups that apply to `userAgent`
 * (an exact-ish token match) or to `*`. A matching specific group wins over `*`.
 */
export function parseRobotsTxt(text: string, userAgentToken: string): RobotsRules {
  const specific: RobotsRules['rules'] = [];
  const wildcard: RobotsRules['rules'] = [];
  let specificDelay: number | null = null;
  let wildcardDelay: number | null = null;

  let currentAgents: string[] = [];
  let inGroup = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      if (!inGroup) currentAgents = [];
      currentAgents.push(value.toLowerCase());
      inGroup = true;
      continue;
    }
    inGroup = false;
    if (currentAgents.length === 0) continue;

    const needle = userAgentToken.toLowerCase();
    const appliesSpecific = currentAgents.some((a) => a !== '*' && needle.includes(a));
    const appliesWildcard = currentAgents.includes('*');
    if (!appliesSpecific && !appliesWildcard) continue;
    const target = appliesSpecific ? specific : wildcard;

    if (field === 'disallow') {
      // "Disallow:" with an empty value means "allow everything".
      if (value !== '') target.push({ allow: false, pattern: value });
    } else if (field === 'allow') {
      if (value !== '') target.push({ allow: true, pattern: value });
    } else if (field === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        if (appliesSpecific) specificDelay = seconds;
        else wildcardDelay = seconds;
      }
    }
  }

  const rules = specific.length > 0 ? specific : wildcard;
  const crawlDelaySeconds = specific.length > 0 ? specificDelay : wildcardDelay;
  // Longest pattern wins, as per the de-facto standard.
  rules.sort((a, b) => b.pattern.length - a.pattern.length);
  return { rules, crawlDelaySeconds, assumedAllowed: false, fetchedAt: Date.now() };
}

/** Applies parsed rules to a path. Absence of any matching rule means allowed. */
export function isPathAllowed(rules: RobotsRules, pathWithQuery: string): boolean {
  for (const rule of rules.rules) {
    if (patternToRegExp(rule.pattern).test(pathWithQuery)) return rule.allow;
  }
  return true;
}

/** Fetches (and caches) robots.txt for an origin. */
export async function loadRobots(
  origin: string,
  userAgent: string,
  timeoutMs = 15_000,
): Promise<RobotsRules> {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const url = `${origin}/robots.txt`;
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'text/plain,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });

    if (response.status === 401 || response.status === 403) {
      // Access to robots.txt itself is restricted: treat the site as off-limits.
      const closed: RobotsRules = {
        rules: [{ allow: false, pattern: '/' }],
        crawlDelaySeconds: null,
        assumedAllowed: false,
        fetchedAt: Date.now(),
      };
      cache.set(origin, closed);
      logger.warn('robots.txt is access-restricted; treating the site as disallowed', {
        origin,
        status: response.status,
      });
      return closed;
    }

    if (response.status === 404 || response.status === 410) {
      const open: RobotsRules = {
        rules: [],
        crawlDelaySeconds: null,
        assumedAllowed: false,
        fetchedAt: Date.now(),
      };
      cache.set(origin, open);
      return open;
    }

    if (!response.ok) throw new Error(`robots.txt returned HTTP ${response.status}`);

    const parsed = parseRobotsTxt(await response.text(), userAgent);
    cache.set(origin, parsed);
    logger.info('robots.txt loaded', {
      origin,
      rules: parsed.rules.length,
      crawlDelay: parsed.crawlDelaySeconds ?? 'none',
    });
    return parsed;
  } catch (err) {
    // Transient failure: proceed, but say so and re-check soon.
    const assumed: RobotsRules = {
      rules: [],
      crawlDelaySeconds: null,
      assumedAllowed: true,
      // Short TTL so we retry in 10 minutes rather than 6 hours.
      fetchedAt: Date.now() - (CACHE_TTL_MS - 10 * 60 * 1000),
    };
    cache.set(origin, assumed);
    logger.warn('Could not read robots.txt; proceeding with the configured interval', {
      origin,
      error: describeError(err),
    });
    return assumed;
  }
}

/** Test helper: drops the cached robots.txt. */
export function clearRobotsCache(): void {
  cache.clear();
}
