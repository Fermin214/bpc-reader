import { createHash } from 'node:crypto';
import { defaultSiteRegistry } from './site-registry.mjs';

export const supportedSites = defaultSiteRegistry.domains;
export const adapterVersion = 'visible-article-7';
export const defaultDriver = process.platform === 'win32' ? 'chromium-cdp' : 'chromium';
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function validateSession(session) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(session)) throw new Error('session must be a short name, not a path');
}
export function validateArticleUrl(value, siteRegistry = defaultSiteRegistry) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !siteRegistry.find(url)) {
    throw new Error('Supply a WSJ, Reuters or Bloomberg HTTPS article URL');
  }
  return url;
}
export function normalizeArticleUrl(value, siteRegistry = defaultSiteRegistry) {
  const url = validateArticleUrl(value, siteRegistry);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['fbclid', 'gclid'].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  siteRegistry.find(url).normalizeUrl?.(url);
  url.searchParams.sort();
  return url.href;
}
// Discovery admission only. Direct reads deliberately keep their existing URL
// contract so unsupported templates can still produce useful diagnostics.
export function articleCandidate(value, sites, siteRegistry = defaultSiteRegistry) {
  try {
    sites ??= siteRegistry.domains;
    const url = validateArticleUrl(value, siteRegistry);
    if (!sites.some(site => url.hostname === site || url.hostname.endsWith('.' + site))) return null;
    if (url.pathname.split('/').filter(Boolean).length < 2 || /\/(podcasts?|videos?|topics?|search|livecoverage|live|subscribe|subscription|account|login|membership|about|help)(\/|$)/i.test(url.pathname)) return null;
    if (!siteRegistry.find(url)?.isArticleUrl(url)) return null;
    return normalizeArticleUrl(url.href, siteRegistry);
  } catch { return null; }
}
export function validateSearch({ query, sites, from, to, limit = 5 } = {}, siteRegistry = defaultSiteRegistry) {
  if (sites === undefined) sites = siteRegistry.domains;
  if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('query must contain 1 to 500 characters');
  if (!Array.isArray(sites) || !sites.length || sites.some(site => !siteRegistry.domains.includes(site))) throw new Error('sites must contain supported publisher domains');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be between 1 and 20');
  for (const date of [from, to]) if (date !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(date).toISOString().slice(0, 10) !== date)) throw new Error('Dates must be valid YYYY-MM-DD values');
  if (from && to && from > to) throw new Error('from must not be after to');
  return { query: query.trim(), sites: [...new Set(sites)], from, to, limit };
}
export function publicationSelection(article, { from, to } = {}) {
  if (!from && !to) return { accepted: true, reason: 'no_date_filter' };
  const stamp = Date.parse(article.published_at);
  if (!Number.isFinite(stamp)) return { accepted: false, reason: 'publication_date_unknown' };
  const date = new Date(stamp).toISOString().slice(0, 10);
  return { accepted: (!from || date >= from) && (!to || date <= to), reason: 'article_publication_date', date };
}
