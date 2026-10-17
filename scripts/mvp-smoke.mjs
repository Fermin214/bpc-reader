import assert from 'node:assert/strict';
import { rm, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ReaderEngine } from '../src/reader-engine.mjs';
import { launch } from '../src/browser.mjs';
import { startReaderServer } from '../src/reader-server.mjs';
import { readJson, writeJson } from '../src/reader-storage.mjs';
import { normalizeArticleUrl, publicationSelection, digest, adapterVersion } from '../src/reader-config.mjs';
import { verifyBpcAssets } from '../src/bpc-assets.mjs';
import { siteRulesReceipt } from '../src/site-adaptations.mjs';
import { createSiteRegistry, defaultSiteRegistry } from '../src/site-registry.mjs';

// Real Chromium, BPC, DOM adapters, Readability, cache, queue and HTTP routes.
// Controlled publisher-shaped responses let us force expiry/corruption/errors
// without depending on mutable paid sites or consuming the user's session.
const root = resolve('output/playwright/mvp-smoke-' + Date.now());
const stateDir = join(root, 'state');
const session = 'mvp-fixture-' + process.pid;
const profileNames = [];
const requests = new Map();
const events = [];
let active = 0, maximumActive = 0, launches = 0;
const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: This original fixture checks the local article reader using a real browser. Ordered paragraphs, safe useful links and publication metadata must survive extraction. Navigation, recommendations and a subscription preview must never be mistaken for a complete paid article.`);
const html = (path, partial = false) => `<!doctype html><html><head><meta charset="utf-8"><title>Fixture ${path}</title><meta name="author" content="Local fixture"><meta property="article:published_time" content="2024-09-25T09:30:00Z"></head><body><nav>UNRELATED_FIXTURE_MENU</nav><article><h1>Fixture ${path}</h1><div><section>${(partial ? paragraphs.slice(0, 2) : paragraphs).map(p => `<p data-type="paragraph">${p}</p>`).join('')}</section>${partial ? '<div id="cx-paywall">Subscribe to continue reading</div>' : '<p>Copyright © 2026 Dow Jones &amp; Company, Inc.</p>'}</div></article></body></html>`;
const fullA = 'https://www.wsj.com/tech/fixture-full-a-12345678';
const fullB = 'https://www.wsj.com/tech/fixture-full-b-abcdef12';
const preview = 'https://www.wsj.com/tech/fixture-preview';
const failure = 'https://www.wsj.com/tech/fixture-network-error';
const metadataKinds = ['jsonld', 'graph', 'language', 'precedence', 'malformed', 'ambiguous', 'related', 'preview', 'blocked'];
const metadataUrls = metadataKinds.map(kind => `https://www.wsj.com/tech/fixture-metadata-${kind}-1234abcd`);
const metadataDate = '2026-10-16T01:00:00Z';
function metadataHtml(url, kind) {
  const article = { '@type': 'NewsArticle', url: url.href, datePublished: metadataDate,
    author: { name: 'Structured Author' }, inLanguage: 'fr', articleBody: 'HIDDEN_METADATA_BODY_SENTINEL' };
  let data = kind === 'graph' ? { '@graph': [{ '@type': 'WebPage' }, { ...article, author: ['First Author', { name: 'Second Author' }] }] }
    : kind === 'ambiguous' ? [{ ...article, url: 'https://www.wsj.com/other/article-one' }, { ...article, url: 'https://www.wsj.com/other/article-two' }]
      : kind === 'related' ? { ...article, url: 'https://www.wsj.com/other/article' } : article;
  const script = `<script type="application/ld+json">${kind === 'malformed' ? '{broken' : JSON.stringify(data)}</script>`;
  let page = html(url.pathname, kind === 'preview').replace(/<meta name="author"[^>]*>|<meta property="article:published_time"[^>]*>/g, '');
  if (kind === 'jsonld' || kind === 'precedence') page = page.replace('<html>', '<html lang="en">');
  if (kind === 'precedence') page = page.replace('</head>', '<meta name="author" content="Preferred Author"><meta property="article:published_time" content="2024-09-25T09:30:00Z"></head>');
  return page.replace('</head>', script + '</head>').replace('</body>', '<div hidden>HIDDEN_DOM_BODY_SENTINEL</div></body>');
}
const options = { session, driver: 'chromium', stateDir, runtimeFactory: async () => {
  active++; maximumActive = Math.max(maximumActive, active); launches++;
  const name = session + '-' + launches;
  profileNames.push(name);
  const runtime = await launch({ mode: 'bpc', browser: 'chromium', profile: name, headed: false });
  const close = runtime.close;
  runtime.close = async () => { try { await close(); } finally { active--; } };
  await runtime.context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'www.google.com') {
      if (url.searchParams.get('q')?.includes('metadata')) return route.fulfill({ contentType: 'text/html', body: `<html><body><a href="${metadataUrls[0]}"><h3>Metadata article fixture</h3><cite>https://www.wsj.com</cite></a></body></html>` });
      return route.fulfill({ contentType: 'text/html', body: `<html><body><div class="MjjYud"><a href="${fullA}"><h3>Local article fixture A</h3><cite>https://www.wsj.com</cite></a></div><div class="MjjYud"><a href="${fullB}"><h3>Local article fixture B</h3><cite>https://www.wsj.com</cite></a></div></body></html>` });
    }
    if (url.hostname !== 'www.wsj.com') return route.abort();
    requests.set(url.pathname, (requests.get(url.pathname) || 0) + 1);
    if (url.pathname.endsWith('network-error')) return route.abort('connectionfailed');
    const kind = metadataKinds.find(kind => url.href === metadataUrls[metadataKinds.indexOf(kind)]);
    if (kind) return route.fulfill({ status: kind === 'blocked' ? 403 : 200, contentType: 'text/html', body: metadataHtml(url, kind) });
    if (url.pathname.includes('print-end')) return route.fulfill({ contentType: 'text/html', body: html(url.pathname).replace('Copyright © 2026 Dow Jones &amp; Company, Inc.', 'Appeared in the October 16 print edition') });
    return route.fulfill({ contentType: 'text/html', body: html(url.pathname, url.pathname.endsWith('preview')) });
  });
  return runtime;
} };
const makeEngine = () => new ReaderEngine(options);
const check = (label, condition) => { assert(condition, label); events.push(label); console.log('PASS:', label); };
let server;
try {
  const engine = makeEngine();
  const batch = await engine.batch({ urls: [fullA, preview, failure, fullB, fullB + '?utm_source=duplicate'], out: join(root, 'batch') });
  check('Batch deduplicates and preserves input order', batch.items.length === 4 && batch.duplicates_removed === 1 && batch.items[3].url === fullB);
  check('Article errors and previews do not stop later articles', batch.items.map(i => i.result.status).join(',') === 'ok,partial,error,ok');
  check('Real visible extraction preserves the known complete text', batch.items[0].result.content_text === paragraphs.join(' '));
  check('Batch uses and closes one managed browser', batch.browser_launches.length === 1 && batch.browser_launches[0].browser_disconnected);
  const cacheFiles = await readdir(join(stateDir, 'cache'));
  check('Only successful articles enter cache', cacheFiles.length === 2);
  const cached = await makeEngine().batch({ urls: [fullA + '?mod=test', fullB], out: join(root, 'all-cached') });
  check('New engine reuses disk cache without launching browser', cached.summary.cache_hits === 2 && cached.browser_launches.length === 0 && cached.items.every(i => i.result.runtime === null));
  const refresh = await makeEngine().readArticle({ url: fullA, refresh: true, out: join(root, 'refresh') });
  check('Explicit refresh performs new acquisition', refresh.status === 'ok' && !refresh.cache.hit && refresh.cache.reason === 'refresh');
  const cacheFile = join(stateDir, 'cache', refresh.cache.key + '.json');
  const entry = await readJson(cacheFile);
  entry.saved_at = '2000-01-01T00:00:00Z'; await writeJson(cacheFile, entry);
  const expired = await makeEngine().readArticle({ url: fullA, out: join(root, 'expired') });
  check('Expired cache is fetched again', expired.status === 'ok' && expired.cache.reason === 'expired');
  const damaged = await readJson(cacheFile); damaged.result.content_markdown = 'Damaged content'; await writeJson(cacheFile, damaged);
  const repaired = await makeEngine().readArticle({ url: fullA, out: join(root, 'corrupt') });
  check('Corrupt cache cannot become a false success', repaired.status === 'ok' && repaired.cache.reason === 'corrupt' && repaired.content_text === paragraphs.join(' '));
  check('Unknown query parameters remain semantically distinct', normalizeArticleUrl(fullA + '?edition=one') !== normalizeArticleUrl(fullA + '?edition=two'));
  const one = makeEngine(), two = makeEngine();
  await Promise.all([one.readArticle({ url: fullA, refresh: true, out: join(root, 'queue-1') }), two.readArticle({ url: fullB, refresh: true, out: join(root, 'queue-2') })]);
  check('Independent engines cannot open the same session concurrently', maximumActive === 1);
  const pending = await engine.createJob({ urls: [fullA, fullB], out: join(root, 'resumed') });
  pending.state = 'running'; pending.items[0] = { ...pending.items[0], state: 'completed', result: batch.items[0].result, selection: { accepted: true } };
  pending.items[1].state = 'running'; await engine.save(pending);
  const resumed = await makeEngine().runJob(pending.id);
  check('Persisted interrupted queue resumes pending work', resumed.state === 'completed' && resumed.items.every(i => i.state === 'completed') && resumed.summary.ok === 2);
  const untouched = JSON.stringify(await engine.getJob(resumed.id));
  await makeEngine().runJob(resumed.id);
  check('Resuming a completed job keeps its original evidence', JSON.stringify(await engine.getJob(resumed.id)) === untouched);
  const searchJob = await makeEngine().batch({ search: { query: 'fixture', sites: ['wsj.com'], limit: 2 }, read: true, out: join(root, 'search-read') });
  check('Search candidates feed the same cache and acquisition pipeline', searchJob.discovery.candidates.length === 2 && searchJob.summary.ok === 2 && searchJob.summary.cache_hits === 2);
  const filtered = await makeEngine().batch({ search: { query: 'fixture', sites: ['wsj.com'], limit: 2, from: '2026-01-01', to: '2026-12-31' }, read: true, out: join(root, 'date-filter') });
  check('Time filter checks article metadata rather than search snippets', filtered.summary.accepted === 0 && filtered.summary.filtered_out === 2);
  server = await startReaderServer({ engine: makeEngine(), port: 0 });
  const health = await fetch(server.url + '/health').then(r => r.json());
  check('Local HTTP health uses the same runtime configuration', health.status === 'ready' && health.session === session);
  const post = (path, body) => fetch(server.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const apiRead = await (await post('/read', { url: fullA })).json();
  check('HTTP read returns the same cached full article', apiRead.status === 'ok' && apiRead.cache.hit && apiRead.content_text === paragraphs.join(' '));
  const queuedResponse = await post('/jobs', { urls: [fullA, fullB] });
  const queued = await queuedResponse.json();
  let state;
  for (let n = 0; n < 100; n++) { state = await fetch(server.url + queued.status_url).then(r => r.json()); if (['completed', 'failed'].includes(state.state)) break; await new Promise(done => setTimeout(done, 100)); }
  check('HTTP asynchronous job exposes persisted completion', queuedResponse.status === 202 && state.state === 'completed' && state.summary.cache_hits === 2);
  check('HTTP rejects unsupported targets', (await post('/read', { url: 'https://example.com' })).status === 400);
  check('HTTP rejects cross-origin browser requests', (await fetch(server.url + '/health', { headers: { Origin: 'https://example.com' } })).status === 403);
  check('HTTP request cannot override filesystem output path', (await post('/read', { url: fullA, out: 'C:/elsewhere' })).status === 400);
  const metaBatch = await makeEngine().batch({ urls: metadataUrls, refresh: true, out: join(root, 'metadata') });
  const meta = Object.fromEntries(metadataKinds.map((kind, index) => [kind, metaBatch.items[index].result]));
  check('Full-page JSON-LD date, author and HTML language survive visible adaptation', meta.jsonld.status === 'ok' && meta.jsonld.published_at === metadataDate && meta.jsonld.author === 'Structured Author' && meta.jsonld.language === 'en');
  check('Graph authors and JSON-LD language fallback survive adaptation', meta.graph.author === 'First Author, Second Author' && meta.language.language === 'fr');
  check('Existing meta fields and HTML language keep precedence', meta.precedence.author === 'Preferred Author' && meta.precedence.published_at === '2024-09-25T09:30:00Z' && meta.precedence.language === 'en');
  check('Malformed and ambiguous or unrelated metadata remain absent', ['malformed', 'ambiguous', 'related'].every(kind => meta[kind].status === 'ok' && meta[kind].published_at === null && meta[kind].author === null));
  check('Metadata never exports hidden bodies or changes known editorial text', Object.values(meta).every(result => !/HIDDEN_.*BODY_SENTINEL/.test(result.content_text)) && meta.jsonld.content_text === paragraphs.join(' '));
  check('Complete metadata cannot promote previews or blocked responses', meta.preview.status === 'partial' && meta.preview.published_at === metadataDate && meta.blocked.status === 'blocked' && meta.blocked.content_markdown === '');
  const eligible = await makeEngine().batch({ search: { query: 'metadata fixture', sites: ['wsj.com'], limit: 1, from: '2026-10-16', to: '2026-10-16' }, out: join(root, 'metadata-dates') });
  check('Recovered publication date participates in the actual search-reading filter', eligible.summary.accepted === 1 && eligible.items[0].selection.accepted && publicationSelection(meta.jsonld, { from: '2026-10-16' }).accepted);
  const legacyEngine = new ReaderEngine({ ...options, stateDir: join(root, 'legacy-state') });
  const assets = await verifyBpcAssets();
  const previous = adapterVersion.replace(/\d+$/, value => String(Number(value) - 1));
  const oldKey = digest({ url: normalizeArticleUrl(fullA), session: legacyEngine.sessionKey(), adapter: previous, bpc: assets.sha256, site_rules: siteRulesReceipt.sha256, expected: null });
  await legacyEngine.cache.put(oldKey, batch.items[0].result);
  const migrated = await legacyEngine.readArticle({ url: fullA, out: join(root, 'legacy-miss') });
  const again = await legacyEngine.readArticle({ url: fullA, out: join(root, 'legacy-hit') });
  check('Previous pipeline cache cannot mask a new version and new results remain reusable', migrated.status === 'ok' && !migrated.cache.hit && migrated.cache.key !== oldKey && again.cache.hit);
  const printed = await makeEngine().readArticle({ url: 'https://www.wsj.com/tech/fixture-print-end-12345678', refresh: true, out: join(root, 'print-end') });
  check('WSJ print-edition end alternative remains accepted', printed.status === 'ok' && printed.readiness.end_signal === 'publisher_end_marker');
  const mismatch = await makeEngine().readArticle({ url: fullA, expected: { start: 'Wrong reference start', end: 'Wrong reference end' }, refresh: true, out: join(root, 'reference-mismatch') });
  check('Site completion cannot promote a mismatching reference', mismatch.status === 'partial' && mismatch.reasons.includes('reference_mismatch'));
  for (const [kind, override] of [['no-export', { exportDocument() { return null; } }], ['no-evidence', { completionEvidence() { return null; } }]]) {
    const siteRegistry = createSiteRegistry(defaultSiteRegistry.sites.map(site => site.id === 'wsj.com' ? { ...site, ...override } : site));
    const guarded = await new ReaderEngine({ ...options, siteRegistry }).readArticle({ url: fullA, refresh: true, out: join(root, kind) });
    check(kind + ' cannot produce a false successful article', guarded.status === 'partial' && guarded.completeness === 'unknown');
  }
  await writeJson(join(root, 'verification.json'), { status: 'passed', cases: events, max_concurrent_browsers_for_same_session: maximumActive, browser_launches: launches, requests: Object.fromEntries(requests) });
  console.log('MVP smoke passed:', root);
} finally {
  await server?.close();
  const profileRoot = resolve('.cache/profiles');
  for (const name of profileNames) {
    const target = resolve(profileRoot, 'chromium-bpc-' + name);
    if (!target.startsWith(profileRoot + sep)) throw new Error('Cleanup escaped project cache');
    await rm(target, { recursive: true, force: true });
  }
}
