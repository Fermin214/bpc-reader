import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFeed, fetchFeed, createFeedAgents, discoverFeedArticles, validateFeedRequest } from '../src/feed-discovery.mjs';
import { ReaderEngine } from '../src/reader-engine.mjs';
import { publicationSelection } from '../src/reader-config.mjs';
import { defaultSiteRegistry, createSiteRegistry } from '../src/site-registry.mjs';
import { startReaderServer } from '../src/reader-server.mjs';
import { writeJson } from '../src/reader-storage.mjs';

const root = resolve('output/feed-smoke-' + Date.now()), checks = {};
const check = (name, pass) => { assert(pass, name); checks[name] = true; console.log('PASS:', name); };
const full = 'https://www.wsj.com/tech/original-fixture-1234abcd';
const item = (url, guid, date = 'Fri, 16 Oct 2026 01:00:00 GMT', title = 'Original Gaming Fixture') => `<item><title>${title}</title><link>${url.replaceAll('&', '&amp;')}</link><guid isPermaLink="false">${guid}</guid><pubDate>${date}</pubDate><dc:creator>Original Author</dc:creator><description><![CDATA[<p>Original discovery summary.</p>]]></description><content:encoded>HIDDEN_FEED_BODY_SENTINEL</content:encoded></item>`;
const rss = entries => `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Original source</title><language>en</language>${entries}</channel></rss>`;
const xml = rss(item(full + '?mod=rss&utm_source=fixture', 'opaque-one') + item(full, 'different-guid')
  + item('https://www.wsj.com/livecoverage/original-1234abcd', 'live') + item('https://example.org/story', 'external')
  + item('https://www.wsj.com/tech/original-old-abcdef12', 'old', 'Fri, 09 Oct 2026 17:00:00 GMT')
  + item('https://www.wsj.com/tech/original-unknown-abcdef12', 'unknown', 'not-a-date'));
let timedConnectionClosed = false, requests = 0;
const fixture = createServer((req, res) => {
  requests++;
  if (req.url === '/timeout') { req.on('close', () => { timedConnectionClosed = true; }); return; }
  if (req.url === '/304') { res.writeHead(304); return res.end(); }
  if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://example.org/untrusted' }); return res.end(); }
  if (req.url === '/html') { res.setHeader('Content-Type', 'text/html'); return res.end('<html><body>Verification required</body></html>'); }
  if (req.url === '/wire-limit') return res.end(Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  if (req.url === '/inflate-limit') { res.setHeader('Content-Encoding', 'gzip'); return res.end(gzipSync(Buffer.alloc(4 * 1024 * 1024 + 1, 65))); }
  res.setHeader('Content-Type', 'application/rss+xml');
  if (req.url === '/gzip') { res.setHeader('Content-Encoding', 'gzip'); return res.end(gzipSync(xml)); }
  return res.end(req.url === '/empty' ? rss('') : xml);
});
await new Promise(done => fixture.listen(0, '127.0.0.1', done));
const base = 'http://127.0.0.1:' + fixture.address().port, resources = createFeedAgents();
const fetchLocal = (path, timeout = 3000) => fetchFeed({ url: base + path }, { agents: resources.agents, deadline: Date.now() + timeout });
let api;
try {
  check('RSS parses creator/date metadata without encoded body', parseFeed(xml, { url: base }).entries[0].author_hint === 'Original Author' && !JSON.stringify(parseFeed(xml, { url: base })).includes('HIDDEN_FEED_BODY_SENTINEL'));
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://www.wsj.com/tech/"><title>Original Atom</title><entry><id>opaque-entry-id</id><title>Original Atom item</title><link rel="enclosure" href="audio.mp3"/><link rel="alternate" type="text/html" href="original-fixture-1234abcd"/><published>2026-10-16T00:00:00Z</published><updated>2026-10-17T00:00:00Z</updated><author><name>Atom Author</name></author></entry></feed>`;
  const parsedAtom = parseFeed(atom, { url: base });
  check('Atom namespace, relative alternate link, id and dates stay distinct', parsedAtom.format === 'atom' && parsedAtom.entries[0].url === full && parsedAtom.entries[0].entry_id === 'opaque-entry-id' && parsedAtom.entries[0].published_at_hint !== parsedAtom.entries[0].updated_at_hint);
  for (const bad of ['<rss><channel>', '<html><body>Challenge</body></html>', '<!DOCTYPE rss [<!ENTITY external SYSTEM "https://example.org/x">]><rss/>']) {
    check('Malformed/HTML/DTD rejected: ' + bad.slice(0, 16), await Promise.resolve().then(() => parseFeed(bad, { url: base })).then(() => false, () => true));
  }
  check('Missing article link never falls back to GUID', parseFeed(rss('<item><guid>' + full + '</guid></item>'), { url: base }).entries[0].url === null);
  check('Native HTTP and gzip paths produce the same XML', (await fetchLocal('/good')).xml === (await fetchLocal('/gzip')).xml);
  for (const path of ['/304', '/redirect', '/wire-limit', '/inflate-limit', '/timeout']) {
    check('Native failure boundary: ' + path, await fetchLocal(path, path === '/timeout' ? 150 : 3000).then(() => false, () => true));
  }
  await new Promise(done => setTimeout(done, 30));
  check('Timed out socket is actually closed', timedConnectionClosed);
  const fetcher = async (feed, options) => ({ ...await fetchFeed({ url: base + (feed.id === 'bloomberg-technology' ? '/html' : '/good') }, options), final_url: feed.url });
  const result = await discoverFeedArticles({ feed_ids: ['wsj-technology', 'wsj-business', 'bloomberg-technology'], keywords: ['gaming'], from: '2026-10-16', to: '2026-10-16', limit: 1 }, { fetcher, out: join(root, 'multi') });
  check('Multi-source failures remain explicit and successful entries survive', result.status === 'partial' && result.sources.find(s => s.feed_id === 'bloomberg-technology').error === 'feed_not_rss_or_atom');
  check('Normalization deduplicates before limit and retains all source provenance', result.candidates.length === 1 && result.candidates[0].url === full && result.candidates[0].provenance.length === 4 && result.counts.duplicates_removed === 5);
  check('Unknown dates, UTC dates and unsupported URLs have distinct exclusions', result.counts.excluded.publication_date_unknown === 1 && result.counts.excluded.outside_date_range === 1 && result.counts.excluded.unsupported_article_url === 4);
  check('Feed hints cannot satisfy the caller final publication-date check', result.warnings.includes('url_reading_jobs_do_not_inherit_feed_date_filters') && !publicationSelection({published_at:'2026-10-09T17:00:00Z'},{from:'2026-10-10'}).accepted);
  check('Feed content cannot become article content or verified publication fields', !JSON.stringify(result).includes('HIDDEN_FEED_BODY_SENTINEL') && !('content_markdown' in result.candidates[0]) && !('published_at' in result.candidates[0]));
  const before = requests;
  const catalog = await discoverFeedArticles({});
  const noReuters = await discoverFeedArticles({ sites: ['reuters.com'] }, { out: join(root, 'reuters') });
  check('Catalog and Reuters unavailable make no network request', requests === before && catalog.catalog.length === 10 && noReuters.status === 'error' && noReuters.sources[0].status === 'unavailable');
  check('Author sources require explicit selection', !validateFeedRequest({ sites: ['bloomberg.com'] }).feed_ids.includes('bloomberg-jason-schreier') && validateFeedRequest({ feed_ids: ['bloomberg-jason-schreier'] }).feed_ids.length === 1);
  const empty = await discoverFeedArticles({ feed_ids: ['wsj-technology'] }, { out: join(root, 'empty'), fetcher: (feed, options) => fetchFeed({ url: base + '/empty' }, options) });
  const unmatched = await discoverFeedArticles({ feed_ids: ['wsj-technology'], keywords: ['UNMATCHED_LITERAL'] }, { fetcher, out: join(root, 'unmatched') });
  check('Valid empty feeds differ from unmatched filters', empty.status === 'ok' && empty.sources[0].outcome === 'empty_feed' && unmatched.sources[0].outcome === 'no_filter_matches');
  const siteRegistry = createSiteRegistry(defaultSiteRegistry.sites.map(site => site.domain === 'wsj.com' ? { ...site, feeds: [{ id: 'wsj-technology', title: 'Original local fixture feed', url: base + '/good' }] } : site));
  let browserCalls = 0;
  const engine = new ReaderEngine({ stateDir: join(root, 'state'), siteRegistry, runtimeFactory: async () => { browserCalls++; throw new Error('RSS must not launch a browser'); } });
  const discovered = await engine.discoverFeedArticles({ feed_ids: ['wsj-technology'] }, { out: join(root, 'engine') });
  check('RSS engine never acquires browser/session queue', discovered.status === 'ok' && browserCalls === 0 && engine.pending.size === 0 && (await engine.listJobs()).length === 0);
  api = await startReaderServer({ engine, port: 0 });
  const post = async (path, body) => fetch(api.url + path, { method: 'POST', headers: {'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const httpResult = await (await post('/rss-discover', {feed_ids:['wsj-technology'],limit:1})).json();
  check('HTTP RSS is a thin discovery-only entry', httpResult.status === 'ok' && httpResult.candidates[0].url === full && browserCalls === 0);
  check('Old HTTP fields remain strict; RSS cannot override paths', (await post('/read', {url:full,feed_ids:['wsj-technology']})).status === 400 && (await post('/rss-discover', {feed_ids:['wsj-technology'],out:'elsewhere'})).status === 400);
  const cli = await promisify(execFile)(process.execPath, [resolve('src/managed-cli.mjs'), 'rss'], { cwd: resolve(root), windowsHide:true });
  check('Actual CLI catalog works from another cwd without a browser', JSON.parse(cli.stdout).mode === 'catalog');
  await writeJson(join(root, 'verification.json'), { status:'passed', node:process.version, checks });
  console.log('Feed smoke passed:', root);
} finally { await api?.close(); resources.close(); fixture.closeAllConnections(); await new Promise(done => fixture.close(done)); }
