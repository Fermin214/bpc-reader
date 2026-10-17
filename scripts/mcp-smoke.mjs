import assert from 'node:assert/strict';
import { resolve, join, sep } from 'node:path';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ReaderEngine } from '../src/reader-engine.mjs';
import { createReaderMcpServer } from '../src/reader-mcp.mjs';
import { launch } from '../src/browser.mjs';
import { writeJson } from '../src/reader-storage.mjs';
import { createSiteRegistry, defaultSiteRegistry } from '../src/site-registry.mjs';

const isServer = process.argv[2] === '--server';
const root = resolve(isServer ? process.argv[3] : 'output/playwright/mcp-smoke-' + Date.now());
const session = 'mcp-fixture-' + root.split('-').at(-1);
const full = 'https://www.wsj.com/tech/fixture-full-12345678';
const preview = 'https://www.wsj.com/tech/fixture-preview-abcdef12';
const paragraphs = Array.from({ length: 6 }, (_, i) => `Original MCP fixture paragraph ${i + 1}. A model receives the complete visible article, publisher metadata and original citation URL. Search snippets and subscription previews must not enter a factual synthesis. This verifies the actual browser and extraction pipeline over the real MCP transport.`);
if (isServer) {
  const feeds = createServer((req,res) => { res.setHeader('Content-Type','application/rss+xml'); res.end(`<rss version="2.0"><channel><title>Original MCP feed</title>${[full,preview].map((url,i)=>`<item><title>Original feed article ${i}</title><link>${url}</link><guid isPermaLink="false">opaque-${i}</guid><description>Discovery hint only</description></item>`).join('')}</channel></rss>`); });
  await new Promise(done=>feeds.listen(0,'127.0.0.1',done));
  const siteRegistry = createSiteRegistry(defaultSiteRegistry.sites.map(site => site.id === 'wsj.com' ? {...site,feeds:site.feeds.map(feed=>feed.id==='wsj-technology'?{...feed,url:'http://127.0.0.1:'+feeds.address().port+'/original-feed'}:feed)} : site));
  const engine = new ReaderEngine({ session, driver: 'chromium', siteRegistry, stateDir: join(root, 'state'), log: text => console.error(text), runtimeFactory: async () => {
    const runtime = await launch({ mode: 'bpc', browser: 'chromium', profile: session });
    await runtime.context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'www.google.com') {
        const query = url.searchParams.get('q');
        const hits = query.includes('publisherfallback') ? [['https://www.wsj.com/news/world', 'wsj.com']]
          : query.includes('site:bloomberg.com') ? [['https://service.bloomberg.com/portal/sessions/new', 'bloomberg.com'], ['https://www.bloomberg.com/news/articles/2026-10-16/original-fixture', 'bloomberg.com']]
          : query.includes('site:reuters.com') ? [['https://www.reuters.com/about/company', 'reuters.com'], ['https://www.reuters.com/commentary/breakingviews/original-fixture-2026-10-16/', 'reuters.com']]
            : [[full, 'wsj.com'], [preview, 'wsj.com']];
        return route.fulfill({ contentType: 'text/html', body: `<html><body>${hits.map(([url, site]) => `<div class="MjjYud"><a href="${url}"><h3>Original MCP fixture</h3><cite>https://www.${site}</cite></a></div>`).join('')}</body></html>` });
      }
      if (url.hostname !== 'www.wsj.com') return route.abort();
      if (url.pathname === '/search') return route.fulfill({ contentType: 'text/html', body: `<html><body><a href="${full}">Original publisher search article fixture</a></body></html>` });
      const partial = url.pathname.includes('preview');
      const metadata = { '@type': 'NewsArticle', url: url.href, datePublished: '2026-10-16T01:00:00Z', author: { name: 'MCP Structured Author' }, articleBody: 'HIDDEN_MCP_BODY_SENTINEL' };
      return route.fulfill({ contentType: 'text/html', body: `<html lang="en"><head><meta charset="utf-8"><title>Original MCP fixture</title><script type="application/ld+json">${JSON.stringify(metadata)}</script></head><body><article><h1>Original MCP fixture</h1><div><section>${paragraphs.slice(0, partial ? 2 : 6).map(p => `<p data-type="paragraph">${p}</p>`).join('')}</section>${partial ? '<div id="cx-paywall">Subscribe to continue reading</div>' : '<p>Copyright © 2026 Dow Jones &amp; Company, Inc.</p>'}</div></article></body></html>` });
    });
    return runtime;
  } });
  serveStdio(() => createReaderMcpServer({ engine }));
  process.stdin.once('end', () => engine.tail.finally(() => { feeds.close(); process.exit(0); }));
} else {
  const client = new Client({ name: 'reader-mcp-e2e', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('scripts/mcp-smoke.mjs'), '--server', root], cwd: resolve('.'), stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  const cases = [];
  const check = (label, passed) => { assert(passed, label); cases.push(label); console.log('PASS:', label); };
  const call = async (name, args = {}) => await client.callTool({ name, arguments: args }, { timeout: 180000 });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    check('Stdio handshake exposes seven strict tool schemas', tools.tools.length === 7 && tools.tools.some(tool => tool.name === 'discover_feed_articles') && tools.tools.every(tool => tool.inputSchema.additionalProperties === false));
    const catalog = await call('discover_feed_articles');
    check('RSS catalog is explicit and does not enqueue reading jobs', catalog.structuredContent.mode === 'catalog' && catalog.structuredContent.catalog.length === 10 && (await call('reader_health')).structuredContent.queued_or_running === 0);
    check('RSS arbitrary URLs cannot override the built-in catalog', (await call('discover_feed_articles', { url: 'https://example.com/feed' })).isError === true);
    const noReuters = await call('discover_feed_articles', { sites: ['reuters.com'] });
    check('Reuters unavailable is explicit instead of a successful empty feed', noReuters.isError === true && noReuters.structuredContent.sources[0].error === 'no_verified_builtin_feed');
    const rss = (await call('discover_feed_articles', {feed_ids:['wsj-technology']})).structuredContent;
    check('Actual MCP RSS uses native HTTP and returns candidate hints', rss.status === 'ok' && rss.candidates.length === 2 && rss.candidates[0].url === full && !('content_markdown' in rss.candidates[0]));
    check('Health does not launch a browser', (await call('reader_health')).structuredContent.queued_or_running === 0);
    const prompt = await client.getPrompt({ name: 'research_topic', arguments: { topic: 'Original fixture research' } });
    check('Research prompt requires full bodies and source citations', /summarizable=true/.test(prompt.messages[0].content.text) && /source_url/.test(prompt.messages[0].content.text));
    const unsupported = await call('read_article', { url: 'https://example.com/article' });
    check('Unsupported targets fail before browser acquisition', unsupported.isError === true);
    const arbitraryPath = await call('start_reading_job', { urls: [full], out: 'C:/elsewhere' });
    check('Model cannot override filesystem output', arbitraryPath.isError === true);
    const search = (await call('search_articles', { query: 'original fixture', sites: ['wsj.com'], limit: 2 })).structuredContent;
    check('Real MCP search discovers original fixture links', search.status === 'ok' && search.candidates[0].url === full && search.candidates[1].url === preview);
    for (const site of ['bloomberg.com', 'reuters.com']) {
      const discovered = (await call('search_articles', { query: 'original fixture', sites: [site], limit: 1 })).structuredContent;
      check(site + ' navigation pages are excluded before article selection', discovered.candidates.length === 1 && discovered.candidates[0].url.includes('2026-10-16'));
    }
    const fallback = (await call('search_articles', { query: 'publisherfallback', sites: ['wsj.com'], limit: 1 })).structuredContent;
    check('Publisher search supplies real links when web search has only navigation', fallback.candidates[0]?.url === full && fallback.candidates[0].source === 'publisher_search');
    const created = (await call('start_reading_job', { urls: [...rss.candidates.map(c=>c.url), full], refresh: true })).structuredContent;
    check('Durable batch starts without waiting for browser', created.job_id && created.duplicates_removed === 1);
    let job;
    for (let n = 0; n < 120; n++) {
      job = (await call('get_reading_job', { job_id: created.job_id, include_content: true })).structuredContent;
      if (['completed', 'failed'].includes(job.state)) break;
      await new Promise(done => setTimeout(done, 250));
    }
    const [article, partial] = job.items.map(item => item.article);
    check('Full body and original URL survive MCP batch', job.summary.ok === 1 && article.summarizable && article.content_markdown.includes(paragraphs.at(-1)) && article.source_url === full);
    check('Paywall preview is withheld from model synthesis', job.summary.partial === 1 && !partial.summarizable && !('content_markdown' in partial));
    check('Structured publication and author reach MCP without hidden body leakage', article.published_at === '2026-10-16T01:00:00Z' && article.author === 'MCP Structured Author' && !article.content_markdown.includes('HIDDEN_MCP_BODY_SENTINEL') && partial.published_at === article.published_at);
    const metadata = (await call('get_reading_job', { job_id: created.job_id })).structuredContent;
    check('Polling is compact unless full content is requested', !('content_text' in metadata.items[0].article));
    const cached = (await call('read_article', { url: full })).structuredContent.article;
    check('Single read reuses validated disk cache', cached.cache_hit && cached.content_sha256 === article.content_sha256);
    const resume = await call('resume_reading_job', { job_id: created.job_id });
    check('Resume reuses the same stored job', resume.structuredContent.job_id === created.job_id);
    check('Browser progress stays on stderr without corrupting MCP', stderr.includes('[1/2]') && stderr.includes('Dedicated Chromium ready'));
    await writeJson(join(root, 'verification.json'), { status: 'passed', cases, tools: tools.tools.map(tool => tool.name), job_id: created.job_id });
    console.log('MCP smoke passed:', root);
  } finally {
    await client.close();
    const profileRoot = resolve('.cache/profiles'), profile = resolve(profileRoot, 'chromium-bpc-' + session);
    if (!profile.startsWith(profileRoot + sep)) throw new Error('Cleanup escaped project profiles');
    await rm(profile, { recursive: true, force: true });
  }
}
