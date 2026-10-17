import http from 'node:http';
import https from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';
import { articleCandidate, publicationSelection, validateSearch } from './reader-config.mjs';
import { defaultSiteRegistry } from './site-registry.mjs';
import { projectRoot } from './bpc-assets.mjs';

const wireLimit = 2 * 1024 * 1024, xmlLimit = 4 * 1024 * 1024;
const stamp = () => new Date().toISOString();
const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function feedCatalog(siteRegistry = defaultSiteRegistry) {
  return siteRegistry.sites.flatMap(site => (site.feeds || []).map(feed => ({ ...feed, site: site.domain, kind: feed.kind || 'section' })));
}

export function validateFeedRequest(input = {}, siteRegistry = defaultSiteRegistry) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Supply a feed discovery object');
  for (const key of Object.keys(input)) if (!['sites', 'feed_ids', 'keywords', 'from', 'to', 'limit', 'timeoutMs'].includes(key)) throw new Error('Unsupported feed field: ' + key);
  const { sites, feed_ids, keywords = [], from, to, limit = 20, timeoutMs = 30000 } = input;
  if (sites !== undefined && (!Array.isArray(sites) || !sites.length || sites.some(site => !siteRegistry.domains.includes(site)))) throw new Error('sites must contain supported publisher domains');
  if (feed_ids !== undefined && (!Array.isArray(feed_ids) || !feed_ids.length || feed_ids.length > 20 || feed_ids.some(id => typeof id !== 'string' || !feedCatalog(siteRegistry).some(f => f.id === id)))) throw new Error('Select built-in feed_ids from the catalog');
  if (!Array.isArray(keywords) || keywords.length > 20 || keywords.some(k => typeof k !== 'string' || !k.trim() || k.length > 100)) throw new Error('keywords must be up to 20 nonempty literal phrases');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('Feed timeoutMs must be 1000 to 60000');
  validateSearch({ query: 'feed', sites, from, to, limit }, siteRegistry);
  const catalog = feedCatalog(siteRegistry);
  const selected = feed_ids ? catalog.filter(feed => feed_ids.includes(feed.id))
    : sites ? catalog.filter(feed => sites.includes(feed.site) && feed.kind !== 'author') : [];
  if (sites && selected.some(feed => !sites.includes(feed.site))) throw new Error('feed_ids must belong to the requested sites');
  return { sites: sites ? [...new Set(sites)] : [...new Set(selected.map(feed => feed.site))],
    feed_ids: selected.map(feed => feed.id), keywords: [...new Set(keywords.map(k => k.trim()))], from, to, limit, timeoutMs,
    catalog_only: !sites && !feed_ids };
}

// Native Node proxy agents are instance scoped. No Chromium, global proxy
// mutation, conditional requests, persistent feed cache or TLS exceptions.
export function createFeedAgents(proxy) {
  const proxyEnv = proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1' } : {};
  const agents = { 'http:': new http.Agent({ proxyEnv }), 'https:': new https.Agent({ proxyEnv }) };
  return { agents, close() { Object.values(agents).forEach(agent => agent.destroy()); } };
}

export async function fetchFeed(feed, { agents, deadline = Date.now() + 30000 } = {}) {
  let url = new URL(feed.url);
  const allowedHosts = new Set([url.hostname, ...(feed.redirect_hosts || [])]), redirects = [];
  for (;;) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !allowedHosts.has(url.hostname)) throw new Error('feed_redirect_not_allowed');
    if (redirects.length && (url.protocol !== 'https:' || url.port)) throw new Error('feed_redirect_not_allowed');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('feed_timeout');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
    let response;
    try {
      response = await new Promise((done, reject) => {
        const request = (url.protocol === 'https:' ? https : http).get(url, {
          agent: agents?.[url.protocol], signal: controller.signal,
          headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'BPC-Reader/0.1 RSS discovery' },
        }, done);
        request.once('error', reject);
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        if (!response.headers.location || redirects.length >= 3) throw new Error('feed_redirect_limit_or_missing_location');
        const next = new URL(response.headers.location, url);
        redirects.push({ from: url.href, to: next.href, http_status: response.statusCode }); url = next; continue;
      }
      if (response.statusCode === 304) { response.resume(); throw new Error('feed_not_modified_without_cached_body'); }
      if (response.statusCode !== 200) { response.resume(); throw new Error('feed_http_' + response.statusCode); }
      const chunks = []; let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > wireLimit) { response.destroy(); throw new Error('feed_compressed_size_limit'); }
        chunks.push(chunk);
      }
      let bytes = Buffer.concat(chunks);
      const encoding = (response.headers['content-encoding'] || 'identity').toLowerCase();
      const decoders = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync };
      const decoder = Object.hasOwn(decoders, encoding) ? decoders[encoding] : null;
      if (decoder) bytes = decoder(bytes, { maxOutputLength: xmlLimit });
      else if (encoding !== 'identity') throw new Error('feed_unsupported_content_encoding');
      if (bytes.length > xmlLimit) throw new Error('feed_xml_size_limit');
      const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (Date.now() >= deadline) throw new Error('feed_timeout');
      return { xml, final_url: url.href, http_status: response.statusCode, redirects, wire_bytes: size, xml_bytes: bytes.length,
        content_type: response.headers['content-type'] || null, etag: response.headers.etag || null, last_modified: response.headers['last-modified'] || null };
    } catch (error) {
      response?.destroy();
      if (controller.signal.aborted) throw new Error('feed_timeout');
      throw error;
    } finally { clearTimeout(timer); }
  }
}

export function parseFeed(xml, { url } = {}) {
  if (Buffer.byteLength(xml) > xmlLimit) throw new Error('feed_xml_size_limit');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('feed_dtd_or_entities_not_allowed');
  const declaredEncoding = /<\?xml[^>]*encoding=["']([^"']+)/i.exec(xml)?.[1];
  if (declaredEncoding && !/^utf-?8$/i.test(declaredEncoding)) throw new Error('feed_unsupported_xml_encoding');
  let dom;
  try { dom = new JSDOM(xml.replace(/^\uFEFF/, ''), { contentType: 'text/xml', url, virtualConsole: new VirtualConsole() }); }
  catch { throw new Error('feed_invalid_xml'); }
  const html = new JSDOM('', { virtualConsole: new VirtualConsole() });
  try {
    const root = dom.window.document.documentElement;
    const atom = root.localName === 'feed' && root.namespaceURI === 'http://www.w3.org/2005/Atom';
    if (root.localName !== 'rss' && !atom) throw new Error('feed_not_rss_or_atom');
    const child = (el, name) => [...el.children].find(node => node.localName === name);
    const value = (el, name) => normalize(child(el, name)?.textContent);
    const channel = atom ? root : child(root, 'channel');
    if (!channel) throw new Error('feed_missing_channel');
    const plain = content => {
      const div = html.window.document.createElement('div'); div.innerHTML = content;
      div.querySelectorAll('script,style,iframe').forEach(node => node.remove());
      return normalize(div.textContent).slice(0, 3000);
    };
    const elements = [...channel.children].filter(el => el.localName === (atom ? 'entry' : 'item'));
    if (elements.length > 2000) throw new Error('feed_entry_limit');
    const entries = elements.map(entry => {
      const linkNode = atom ? [...entry.children].find(n => n.localName === 'link' && (!n.getAttribute('rel') || n.getAttribute('rel') === 'alternate') && (!n.getAttribute('type') || /html/.test(n.getAttribute('type')))) : child(entry, 'link');
      const link = atom ? linkNode?.getAttribute('href') : normalize(linkNode?.textContent);
      let base = url;
      for (const node of new Set([root, channel, entry, linkNode].filter(Boolean))) {
        const xmlBase = node.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'base');
        if (xmlBase) { try { base = new URL(xmlBase, base).href; } catch {} }
      }
      let href = null; try { if (link) href = new URL(link, base).href; } catch {}
      return { title: plain(value(entry, 'title')), url: href, entry_id: (value(entry, atom ? 'id' : 'guid') || null)?.slice(0, 1000),
        snippet: plain(value(entry, atom ? 'summary' : 'description')),
        author_hint: atom ? value(child(entry, 'author') || entry, 'name') || null : value(entry, 'creator') || value(entry, 'author') || null,
        published_at_hint: date(value(entry, atom ? 'published' : 'pubDate')), updated_at_hint: atom ? date(value(entry, 'updated')) : null,
        categories: [...entry.children].filter(n => n.localName === 'category').map(n => normalize(atom ? n.getAttribute('term') : n.textContent)).filter(Boolean) };
    });
    return { format: atom ? 'atom' : 'rss', title: value(channel, 'title'), updated_at_hint: date(value(channel, atom ? 'updated' : 'lastBuildDate')),
      language_hint: atom ? root.getAttribute('xml:lang') || null : value(channel, 'language') || null, entries };
  } finally { dom.window.close(); html.window.close(); }
}

export async function discoverFeedArticles(input, { siteRegistry = defaultSiteRegistry, proxy, out, fetcher = fetchFeed } = {}) {
  const request = validateFeedRequest(input, siteRegistry), catalog = feedCatalog(siteRegistry);
  if (request.catalog_only) return { status: 'ok', mode: 'catalog', catalog: catalog.map(({ redirect_hosts, ...feed }) => feed), unavailable_sites: siteRegistry.domains.filter(site => !catalog.some(feed => feed.site === site)), candidates: [] };
  const id = 'rss-' + new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
  const folder = resolve(out || join(projectRoot, 'output/feed-discovery', id));
  await mkdir(folder, { recursive: true });
  const resources = createFeedAgents(proxy), deadline = Date.now() + request.timeoutMs;
  const feeds = catalog.filter(feed => request.feed_ids.includes(feed.id)), sources = [];
  try {
    for (let offset = 0; offset < feeds.length; offset += 2) {
      const settled = await Promise.allSettled(feeds.slice(offset, offset + 2).map(async feed => {
        const source = { feed_id: feed.id, site: feed.site, url: feed.url, fetched_at: stamp(), status: 'error' };
        try {
          const { xml, ...receipt } = await fetcher(feed, { agents: resources.agents, deadline });
          Object.assign(source, receipt);
          source.snapshot_path = join(folder, feed.id + '.xml');
          await writeFile(source.snapshot_path, xml);
          if (Date.now() >= deadline) throw new Error('feed_timeout');
          const parsed = parseFeed(xml, { url: receipt.final_url || feed.url });
          if (Date.now() >= deadline) throw new Error('feed_timeout');
          source.status = 'ok'; source.entry_count = parsed.entries.length;
          source.format = parsed.format; source.updated_at_hint = parsed.updated_at_hint; source.language_hint = parsed.language_hint;
          return { source, entries: parsed.entries };
        } catch (error) { source.error = error.code || error.message; return { source, entries: [] }; }
      }));
      for (const result of settled) {
        if (result.status === 'rejected') throw result.reason;
        sources.push(result.value);
      }
    }
  } finally { resources.close(); }
  for (const site of request.sites) if (!catalog.some(feed => feed.site === site)) sources.push({ source: { site, status: 'unavailable', error: 'no_verified_builtin_feed' }, entries: [] });
  const merged = new Map();
  const excluded = { unsupported_article_url: 0, keywords: 0, outside_date_range: 0, publication_date_unknown: 0 };
  let duplicates = 0;
  for (const { source, entries } of sources) for (const entry of entries) {
    const url = entry.url && articleCandidate(entry.url, [source.site], siteRegistry);
    if (!url) { excluded.unsupported_article_url++; continue; }
    const provenance = { feed_id: source.feed_id, feed_url: source.url, entry_id: entry.entry_id, discovered_at: source.fetched_at,
      title: entry.title, snippet: entry.snippet, author_hint: entry.author_hint, published_at_hint: entry.published_at_hint, updated_at_hint: entry.updated_at_hint };
    if (merged.has(url)) { merged.get(url).provenance.push(provenance); duplicates++; }
    else merged.set(url, { ...entry, url, site: source.site, source: 'rss', discovered_at: source.fetched_at,
      date_filter: request.from || request.to ? 'feed_hint_requires_article_publication_check' : 'not_requested', provenance: [provenance] });
  }
  const filtered = [...merged.values()].filter(candidate => {
    const text = candidate.provenance.map(p => p.title + ' ' + p.snippet).join(' ').toLowerCase();
    if (request.keywords.length && !request.keywords.some(k => text.includes(k.toLowerCase()))) { excluded.keywords++; return false; }
    if (request.from || request.to) {
      const known = candidate.provenance.filter(p => p.published_at_hint);
      if (!known.length) { excluded.publication_date_unknown++; return false; }
      if (!known.some(p => publicationSelection({ published_at: p.published_at_hint }, request).accepted)) { excluded.outside_date_range++; return false; }
    }
    return true;
  });
  for (const { source } of sources) if (source.status === 'ok') source.outcome = source.entry_count === 0 ? 'empty_feed'
    : ![...merged.values()].some(c => c.provenance.some(p => p.feed_id === source.feed_id)) ? 'no_supported_article_urls'
      : !filtered.some(c => c.provenance.some(p => p.feed_id === source.feed_id)) ? 'no_filter_matches' : 'candidates';
  const ok = sources.filter(({ source }) => source.status === 'ok').length;
  const result = { discovery_id: id, mode: 'discovery', status: ok === sources.length ? 'ok' : ok ? 'partial' : 'error',
    request, sources: sources.map(({ source }) => source), candidates: filtered.slice(0, request.limit),
    counts: { entries: sources.reduce((n, s) => n + s.entries.length, 0), unique_supported: merged.size, duplicates_removed: duplicates,
      matching_before_limit: filtered.length, excluded },
    warnings: ['feed_metadata_is_unverified_discovery_only', 'feed_windows_do_not_guarantee_complete_date_coverage', 'dates_use_utc_days'],
    discovered_at: stamp(), artifact_dir: folder };
  if (request.from || request.to) result.warnings.push('url_reading_jobs_do_not_inherit_feed_date_filters');
  await writeFile(join(folder, 'discovery.json'), JSON.stringify(result, null, 2));
  return result;
}
