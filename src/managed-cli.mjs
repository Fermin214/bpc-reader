#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { ReaderEngine } from './reader-engine.mjs';
import { loadSettings } from './reader-settings.mjs';

const help = `BPC-Reader (managed Chromium + bundled BPC)
  reader init
  reader read <https-article-url> [--reference article.json]
  reader batch --input articles.json
  reader search <query> --sites wsj.com,reuters.com [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--limit 5] [--read]
  reader rss [--feeds bloomberg-technology,wsj-technology | --sites bloomberg.com] [--keywords "literal phrase"]
  reader jobs [job-id]
  reader resume <job-id> [--retry-failed]
  reader serve [--port 8787]
Shared: --session name --proxy http://127.0.0.1:7897 --driver chromium|chromium-cdp
        --out folder --timeout 90000 --interactive --refresh --no-cache --cache-ttl 24
Cache TTL is in hours. Search without --read only discovers candidate links.
RSS with no source selection lists the catalog; authors require explicit --feeds.
RSS never reads bodies or opens Chromium. All date filters use UTC days.`;

const log = text => console.error(text);
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    session: { type: 'string' }, proxy: { type: 'string' }, driver: { type: 'string' },
    out: { type: 'string' }, timeout: { type: 'string' }, reference: { type: 'string' }, input: { type: 'string' },
    sites: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, limit: { type: 'string', default: '5' },
    feeds: { type: 'string' }, keywords: { type: 'string', multiple: true },
    'cache-ttl': { type: 'string' }, 'no-cache': { type: 'boolean' }, refresh: { type: 'boolean' },
    'retry-failed': { type: 'boolean' }, read: { type: 'boolean' }, port: { type: 'string' },
    interactive: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (values.help || !positionals.length) console.log(help);
  else {
    const settings = await loadSettings();
    const engine = new ReaderEngine({ session: values.session || settings.session, proxy: values.proxy ?? settings.proxy, driver: values.driver || settings.driver,
      cacheTtlMs: values['no-cache'] ? 0 : Number(values['cache-ttl'] ?? settings.cacheTtlHours) * 3600000, log });
    const options = { out: values.out, refresh: values.refresh, interactive: values.interactive,
      timeoutMs: Number(values.timeout || (values.interactive ? '600000' : '90000')) };
    let result;
    switch (positionals[0]) {
      case 'init': result = await engine.initialize(); break;
      case 'read': {
        let expected;
        if (values.reference) {
          const reference = JSON.parse(await readFile(values.reference, 'utf8'));
          if (reference.url !== positionals[1] || !reference.readiness?.first_paragraph || !reference.readiness?.last_paragraph) throw new Error('Reference must be a previously inspected result for the same URL with article boundaries');
          expected = { start: reference.readiness.first_paragraph, end: reference.readiness.last_paragraph, minParagraphs: reference.metrics.paragraphs };
        }
        result = await engine.readArticle({ ...options, url: positionals[1], expected }); break;
      }
      case 'batch': {
        const urls = values.input ? JSON.parse(await readFile(values.input, 'utf8')) : positionals.slice(1);
        result = await engine.batch({ ...options, urls }); break;
      }
      case 'search': result = await engine.batch({ ...options, read: !!values.read,
        search: { query: positionals.slice(1).join(' '), sites: values.sites?.split(',').map(site => site.trim()), from: values.from, to: values.to, limit: Number(values.limit) } }); break;
      case 'rss': {
        if (values.read || values.interactive) throw new Error('RSS only discovers links; select URLs and use read/batch for bodies or verification');
        result = await engine.discoverFeedArticles({ feed_ids: values.feeds?.split(',').map(id => id.trim()), sites: values.sites?.split(',').map(site => site.trim()),
          keywords: values.keywords, from: values.from, to: values.to, limit: Number(values.limit), timeoutMs: values.timeout ? Number(values.timeout) : undefined }, { out: values.out });
        break;
      }
      case 'jobs': result = positionals[1] ? await engine.getJob(positionals[1]) : await engine.listJobs(); break;
      case 'resume': result = await engine.runJob(positionals[1], { retryFailed: !!values['retry-failed'] }); break;
      case 'serve': {
        const { startReaderServer } = await import('./reader-server.mjs');
        const server = await startReaderServer({ engine, port: Number(values.port ?? settings.port), log });
        console.log(JSON.stringify({ status: 'listening', url: server.url, session: engine.session }, null, 2));
        const stop = async () => { await server.close(); };
        process.once('SIGINT', stop); process.once('SIGTERM', stop);
        break;
      }
      default: throw new Error('Unknown reader command. Use --help');
    }
    if (result) {
      console.log(JSON.stringify(result, null, 2));
      if (result.state === 'failed' || result.status && !['ok', 'ready'].includes(result.status)
        || result.summary && result.summary.partial + result.summary.blocked + result.summary.error > 0) process.exitCode = 2;
    }
  }
} catch (error) {
  console.log(JSON.stringify({ status: 'error', reasons: ['configuration_or_initialization_failed'], error: error.message, content_markdown: '' }, null, 2));
  process.exitCode = 1;
}
