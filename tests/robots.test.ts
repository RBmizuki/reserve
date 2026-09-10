/**
 * robots.txt handling. We must obey it, including Crawl-delay.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPathAllowed, parseRobotsTxt } from '../src/checker/robots.js';

const UA = 'Mozilla/5.0 (Macintosh) Chrome/131.0.0.0 Safari/537.36';

describe('parseRobotsTxt', () => {
  it('allows a path no rule mentions', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /private/\n', UA);
    assert.equal(isPathAllowed(rules, '/hotel/list/?searchHotelCD=DHM'), true);
    assert.equal(isPathAllowed(rules, '/private/x'), false);
  });

  it('honours a blanket disallow', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /\n', UA);
    assert.equal(isPathAllowed(rules, '/hotel/list/'), false);
  });

  it('treats an empty Disallow as "allow everything"', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow:\n', UA);
    assert.equal(isPathAllowed(rules, '/hotel/list/'), true);
  });

  it('lets a longer Allow override a shorter Disallow', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /hotel/\nAllow: /hotel/list/\n', UA);
    assert.equal(isPathAllowed(rules, '/hotel/list/?a=1'), true);
    assert.equal(isPathAllowed(rules, '/hotel/booking/'), false);
  });

  it('supports * and $ wildcards', () => {
    const rules = parseRobotsTxt('User-agent: *\nDisallow: /*.pdf$\n', UA);
    assert.equal(isPathAllowed(rules, '/docs/file.pdf'), false);
    assert.equal(isPathAllowed(rules, '/docs/file.pdf?x=1'), true);
    assert.equal(isPathAllowed(rules, '/hotel/list/'), true);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobotsTxt('# hello\n\nUser-agent: *\nDisallow: /x/ # trailing\n', UA);
    assert.equal(isPathAllowed(rules, '/x/y'), false);
  });

  it('reads Crawl-delay', () => {
    const rules = parseRobotsTxt('User-agent: *\nCrawl-delay: 30\nDisallow:\n', UA);
    assert.equal(rules.crawlDelaySeconds, 30);
  });

  it('prefers a group naming our agent over the wildcard group', () => {
    const text = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: Chrome',
      'Disallow: /nope/',
      'Crawl-delay: 5',
    ].join('\n');
    const rules = parseRobotsTxt(text, UA);
    assert.equal(isPathAllowed(rules, '/hotel/list/'), true);
    assert.equal(isPathAllowed(rules, '/nope/x'), false);
    assert.equal(rules.crawlDelaySeconds, 5);
  });

  it('applies consecutive User-agent lines to the same group', () => {
    const text = 'User-agent: Googlebot\nUser-agent: *\nDisallow: /blocked/\n';
    const rules = parseRobotsTxt(text, UA);
    assert.equal(isPathAllowed(rules, '/blocked/x'), false);
  });
});
