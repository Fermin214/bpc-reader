import assert from 'node:assert/strict';
import { resolve, join, sep } from 'node:path';
import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ReaderEngine } from '../src/reader-engine.mjs';
import { createReaderMcpServer } from '../src/reader-mcp.mjs';
import { createSiteRegistry, defaultSiteRegistry } from '../src/site-registry.mjs';
import { startReaderServer } from '../src/reader-server.mjs';
import { launch } from '../src/browser.mjs';
import { writeJson } from '../src/reader-storage.mjs';
import { fourthSite, domain, fullUrl, previewUrl, noEndUrl, blockedUrl, paragraphs, fixtureHtml } from './fixtures/fourth-site.mjs';

const isServer = process.argv[2] === '--server';
const root = resolve(isServer ? process.argv[3] : 'output/playwright/site-registry-smoke-' + Date.now());
const session = 'registry-fixture-' + root.split('-').at(-1);
const siteRegistry = createSiteRegistry([...defaultSiteRegistry.sites, fourthSite]);
let launches = 0;
const makeEngine = () => new ReaderEngine({ session, driver: 'chromium', siteRegistry, stateDir: join(root, 'state'), log: text => console.error(text),
  runtimeFactory: async ({ siteRegistry }) => {
    launches++;
    const runtime = await launch({ mode: 'bpc', browser: 'chromium', profile: session, siteRegistry });
    await runtime.context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'www.google.com') {
        const query = url.searchParams.get('q') || '';
        const candidates = query.includes('publisherfallback') ? ['https://' + domain + '/topics/navigation']
          : query.includes('site:' + domain) ? [fullUrl, fullUrl + '?ref=duplicate', previewUrl]
            : ['https://www.wsj.com/tech/fixture-registry-12345678'];
        const source = query.includes('site:' + domain) || query.includes('publisherfallback') ? domain : 'wsj.com';
        return route.fulfill({ contentType: 'text/html', body: '<html><body>' + candidates.map(url =>
          '<div class="MjjYud"><a href="' + url + '"><h3>Original registry search article</h3><cite>https://' + source + '</cite></a></div>').join('') + '</body></html>' });
      }
      if (url.hostname !== domain) return route.abort();
      if (url.pathname === '/find') return route.fulfill({ contentType: 'text/html', body:
        '<html><body><a data-fourth-result href="' + fullUrl + '">Original fourth publisher article result</a></body></html>' });
      if (!route.request().isNavigationRequest()) return route.abort();
      return route.fulfill({ status: url.pathname.endsWith('/blocked') ? 403 : 200, contentType: 'text/html', body: fixtureHtml(url) });
    });
    return runtime;
  } });

if (isServer) {
  const engine = makeEngine();
  serveStdio(() => createReaderMcpServer({ engine }));
  process.stdin.once('end', () => engine.tail.finally(() => process.exit(0)));
} else {
  const cases = [];
  const check = (label, condition) => { assert(condition, label); cases.push(label); console.log('PASS:', label); };
  const engine = makeEngine();
  let http, client;
  try {
    check('Default production registry remains immutable and limited to three sites', Object.isFrozen(defaultSiteRegistry.sites)
      && defaultSiteRegistry.domains.join(',') === 'wsj.com,reuters.com,bloomberg.com' && defaultSiteRegistry.find(fullUrl) === null);
    const direct = await engine.readArticle({ url: fullUrl, refresh: true, out: join(root, 'direct') });
    check('Fourth site reaches ok through the same managed browser and extraction pipeline', direct.status === 'ok'
      && direct.content_text === paragraphs.join(' ') && direct.extraction_scope === fourthSite.scope);
    check('Fourth metadata and HTML language survive without site-specific extraction changes', direct.published_at === '2026-10-16T02:00:00Z'
      && direct.author === 'Original Fourth Author' && direct.language === 'de');
    check('Fourth export and metadata never leak hidden content or navigation', !/HIDDEN_FOURTH|UNRELATED_FOURTH/.test(direct.content_text));
    check('Fourth test site does not change bundled BPC configuration', direct.runtime.extension.enabled_domains.slice().sort().join(',')
      === defaultSiteRegistry.bpcDomains.slice().sort().join(',') && direct.runtime.extension.local_site_rules.applied_actions === 2);
    const initialLaunches = launches;
    const cached = await engine.readArticle({ url: fullUrl + '?ref=cache', out: join(root, 'cached') });
    check('Fourth normalization and success cache work without a browser launch', cached.cache.hit && launches === initialLaunches && cached.content_sha256 === direct.content_sha256);
    const discovered = await engine.searchArticles({ query: 'fourth fixture', sites: [domain], limit: 2 }, { out: join(root, 'search') });
    check('Fourth discovery applies its own URL rules and deduplicates candidates', discovered.discovery.candidates.map(hit => hit.url).join(',') === fullUrl + ',' + previewUrl);
    const fallback = await engine.searchArticles({ query: 'publisherfallback', sites: [domain], limit: 1 }, { out: join(root, 'fallback') });
    check('Fourth publisher search uses module-provided readiness and links', fallback.discovery.candidates[0]?.url === fullUrl && fallback.discovery.candidates[0].source === 'publisher_search');
    const eligible = await engine.batch({ search: { query: 'fourth fixture', sites: [domain], limit: 1, from: '2026-10-16', to: '2026-10-16' }, out: join(root, 'eligible') });
    check('Fourth search-reading shares metadata date selection and cache', eligible.summary.accepted === 1 && eligible.summary.cache_hits === 1);
    const outside = await engine.batch({ search: { query: 'fourth fixture', sites: [domain], limit: 1, from: '2027-01-01' }, out: join(root, 'outside') });
    check('Out-of-range metadata rejects selection without downgrading a complete body', outside.items[0].result.status === 'ok' && !outside.items[0].selection.accepted);
    const batch = await engine.batch({ urls: [fullUrl, previewUrl, noEndUrl, blockedUrl, fullUrl + '?ref=duplicate'], out: join(root, 'batch') });
    check('Fourth batch preserves deduplication, order and independent failure results', batch.duplicates_removed === 1
      && batch.items.map(item => item.result.status).join(',') === 'ok,partial,partial,blocked');
    check('Long visible preview remains partial despite full metadata and a footer', batch.items[1].result.metrics.text_chars > 600
      && batch.items[1].result.diagnostics.site_evidence.completion.satisfied && batch.items[1].result.readiness.visible_paywall);
    check('Missing footer and forged structured complete flag cannot produce ok', batch.items[2].result.status === 'partial'
      && !batch.items[2].result.diagnostics.site_evidence.completion.satisfied && batch.items[2].result.published_at === direct.published_at);
    check('Blocked fourth body is blank and partial results never enter cache', batch.items[3].result.content_markdown === ''
      && !(await engine.cache.get(batch.items[1].cache_key)).hit && !(await engine.cache.get(batch.items[2].cache_key)).hit);
    http = await startReaderServer({ engine, port: 0 });
    // The OS may assign a port forbidden by fetch's browser port list. Exercise
    // the actual bound loopback HTTP server with Node's native HTTP client.
    const post = (path, body) => new Promise((done, reject) => {
      const request = httpRequest(http.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => done({ status: response.statusCode, json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.once('error', reject); request.end(JSON.stringify(body));
    });
    const apiRead = await (await post('/read', { url: fullUrl })).json();
    check('HTTP fourth read uses the same cached body and metadata', apiRead.status === 'ok' && apiRead.cache.hit && apiRead.language === 'de');
    const apiPreview = await (await post('/read', { url: previewUrl })).json();
    check('HTTP keeps its compatible raw partial body', apiPreview.status === 'partial' && apiPreview.content_markdown.length > 600);
    const createdResponse = await post('/jobs', { urls: [fullUrl] });
    const created = await createdResponse.json();
    const poll = async id => {
      let job;
      for (let i = 0; i < 200; i++) { job = await engine.getJob(id); if (['completed', 'failed'].includes(job.state)) return job; await new Promise(done => setTimeout(done, 100)); }
      throw new Error('Fixture job did not finish');
    };
    const completed = await poll(created.job_id);
    check('HTTP asynchronous fourth job exposes successful persisted completion', createdResponse.status === 202 && completed.summary.ok === 1);
    const interrupted = await engine.createJob({ urls: [fullUrl, previewUrl], out: join(root, 'interrupted') });
    interrupted.state = 'running'; interrupted.items[0] = { ...interrupted.items[0], state: 'completed', result: direct, selection: { accepted: true } };
    interrupted.items[1].state = 'running'; await engine.save(interrupted);
    const originalItem = JSON.stringify(interrupted.items[0]);
    const resumeResponse = await post('/jobs/' + interrupted.id + '/resume', {});
    const resumed = await poll(interrupted.id);
    check('Fourth interrupted jobs resume without rewriting completed article evidence', resumeResponse.status === 202 && resumed.summary.partial === 1
      && JSON.stringify(resumed.items[0]) === originalItem);
    client = new Client({ name: 'fourth-registry-e2e', version: '0.1.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('scripts/site-registry-smoke.mjs'), '--server', root], cwd: resolve('.'), stderr: 'pipe' });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    const call = async (name, args = {}) => await client.callTool({ name, arguments: args }, { timeout: 180000 });
    const tools = (await client.listTools()).tools;
    const schema = tools.find(tool => tool.name === 'search_articles').inputSchema;
    check('Real stdio MCP derives four-site schema from its engine registry', tools.length === 7 && schema.properties.sites.maxItems === 4
      && schema.properties.sites.items.enum.includes(domain));
    const allSites = await call('search_articles', { query: 'all sites fixture', sites: siteRegistry.domains, limit: 1 });
    check('MCP accepts a four-site search without a hard-coded max three', allSites.structuredContent.status === 'ok' && !allSites.isError);
    const modelJob = (await call('get_reading_job', { job_id: batch.id, include_content: true })).structuredContent;
    check('MCP shares persisted fourth jobs and only exposes successful full body', modelJob.items[0].article.summarizable
      && modelJob.items[0].article.content_markdown.includes(paragraphs.at(-1))
      && modelJob.items.slice(1).every(item => !item.article.summarizable && !('content_markdown' in item.article)));
    const modelOutside = (await call('get_reading_job', { job_id: outside.id, include_content: true })).structuredContent;
    check('MCP withholds full but date-ineligible fourth content', modelOutside.items[0].article.status === 'ok'
      && !modelOutside.items[0].article.summarizable && !('content_markdown' in modelOutside.items[0].article));
    const modelRead = (await call('read_article', { url: fullUrl })).structuredContent.article;
    check('MCP fourth single read uses success cache and citation contract', modelRead.cache_hit && modelRead.source_url === fullUrl && modelRead.author === direct.author);
    const mcpCreated = (await call('start_reading_job', { urls: [fullUrl] })).structuredContent;
    let mcpJob;
    for (let i = 0; i < 100; i++) { mcpJob = (await call('get_reading_job', { job_id: mcpCreated.job_id, include_content: true })).structuredContent; if (mcpJob.state === 'completed') break; await new Promise(done => setTimeout(done, 100)); }
    check('MCP asynchronous fourth reading and resume keep existing tool contracts', mcpJob.summary.ok === 1
      && (await call('resume_reading_job', { job_id: mcpCreated.job_id })).structuredContent.job_id === mcpCreated.job_id);
    const cli = spawnSync(process.execPath, [resolve('src/managed-cli.mjs'), 'read', fullUrl], { cwd: resolve('.'), encoding: 'utf8', windowsHide: true });
    check('Default production CLI rejects the test-only fourth domain', cli.status === 1 && JSON.parse(cli.stdout).status === 'error');
    const productionClient = new Client({ name: 'production-registry-check', version: '0.1.0' });
    const productionTransport = new StdioClientTransport({ command: process.execPath, args: [resolve('src/mcp-cli.mjs')], cwd: resolve('.'), stderr: 'pipe' });
    productionTransport.stderr?.on('data', () => {});
    try {
      await productionClient.connect(productionTransport);
      const productionTools = (await productionClient.listTools()).tools;
      const rejected = await productionClient.callTool({ name: 'read_article', arguments: { url: fullUrl } });
      check('Default production MCP still exposes three sites and rejects the fixture', productionTools.find(tool => tool.name === 'search_articles').inputSchema.properties.sites.maxItems === 3 && rejected.isError === true);
    } finally { await productionClient.close(); }
    await writeJson(join(root, 'verification.json'), { status: 'passed', cases, production_sites: defaultSiteRegistry.domains,
      fixture_site: domain, direct_hash: direct.content_sha256, fixture_browser_launches: launches, job_id: batch.id, http_url: http.url });
    console.log('Registry smoke passed:', root);
  } finally {
    await client?.close();
    await http?.close();
    const profileRoot = resolve('.cache/profiles'), profile = resolve(profileRoot, 'chromium-bpc-' + session);
    if (!profile.startsWith(profileRoot + sep)) throw new Error('Cleanup escaped project profiles');
    await rm(profile, { recursive: true, force: true });
  }
}

