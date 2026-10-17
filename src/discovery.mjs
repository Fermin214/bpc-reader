import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateSearch, articleCandidate } from './reader-config.mjs';
import { defaultSiteRegistry } from './site-registry.mjs';

// Resolve the actual search-result redirect with normal browser navigation.
// Stop at document commit; never decode opaque links or recover hidden content.
async function resolveResult(context, href, sites, siteRegistry) {
  const direct = articleCandidate(href, sites, siteRegistry);
  if (direct) return direct;
  const link = new URL(href);
  if (!['www.google.com', 'google.com'].includes(link.hostname) || !['/goto', '/url'].includes(link.pathname)) return null;
  const plain = link.searchParams.get('q') || link.searchParams.get('url');
  const decoded = plain && articleCandidate(plain, sites, siteRegistry);
  if (decoded) return decoded;
  const page = await context.newPage();
  let found = null;
  try {
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) found ||= articleCandidate(request.url(), sites, siteRegistry);
    });
    await page.route('**/*', async route => {
      const request = route.request();
      const candidate = request.isNavigationRequest() && request.frame() === page.mainFrame() ? articleCandidate(request.url(), sites, siteRegistry) : null;
      if (candidate) { found = candidate; await route.abort(); }
      else if (['www.google.com', 'google.com'].includes(new URL(request.url()).hostname)) await route.continue();
      else await route.abort();
    });
    await page.goto(href, { waitUntil: 'commit', timeout: 12000 }).catch(() => {});
    return found || articleCandidate(page.url(), sites, siteRegistry);
  } finally { await page.close().catch(() => {}); }
}

export async function discoverArticles(context, input, { out, log, interactive = false, timeoutMs = 600000, onState, siteRegistry = defaultSiteRegistry } = {}) {
  const search = validateSearch(input, siteRegistry);
  const candidates = [], pages = [], warnings = [], sourceErrors = [], seen = new Set(), successfulSources = new Set(), skipGoogle = new Set();
  await mkdir(out, { recursive: true });
  let page = await context.newPage();
  let status = 'ok', error = null;
  try {
    for (let round = 0; round < 3 && candidates.length < search.limit; round++) {
      for (const site of search.sites) {
      if (candidates.length >= search.limit) break;
      if (skipGoogle.has(site)) continue;
      try {
      const offset = round * 10;
      const before = search.to ? new Date(Date.parse(search.to) + 86400000).toISOString().slice(0, 10) : null;
      const query = `${search.query} site:${site}${search.from ? ' after:' + search.from : ''}${before ? ' before:' + before : ''}`;
      const url = new URL('https://www.google.com/search');
      url.search = new URLSearchParams({ q: query, hl: 'en', gl: 'us', start: String(offset), num: '10' }).toString();
      log?.(`Searching ${search.sites.join(', ')}: ${search.query}`);
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => document.querySelector('a h3') || /unusual traffic|not a robot|did not match any documents|no results found|验证码|异常流量/i.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {});
      let text = await page.locator('body').innerText();
      await writeFile(join(out, `search-${site}-${offset}.html`), await page.content());
      if (response?.status() >= 400) throw new Error('search_http_' + response.status());
      const challenged = () => /unusual traffic|not a robot|异常流量|验证码/i.test(text) || page.url().includes('/sorry/');
      if (interactive && challenged()) {
        await onState?.('waiting_for_search_verification');
        await writeFile(join(out, 'interaction-required.json'), JSON.stringify({ state: 'waiting_for_search_verification', url: page.url() }));
        await page.screenshot({ path: join(out, 'page.png'), timeout: 5000 }).catch(() => {});
        log?.('Complete the search verification in the dedicated browser. This command will continue automatically.');
        const until = Date.now() + timeoutMs;
        do {
          if (page.isClosed()) throw new Error('Search page closed');
          await new Promise(done => setTimeout(done, 750));
          text = await page.locator('body').innerText().catch(() => text);
        } while (challenged() && Date.now() < until);
        await writeFile(join(out, 'interaction-required.json'), JSON.stringify({ state: challenged() ? 'not_completed' : 'completed', finished_at: new Date().toISOString() }));
        await writeFile(join(out, `search-${site}-${offset}.html`), await page.content());
        await onState?.('searching');
      }
      if (challenged()) {
        sourceErrors.push({ source: 'google_web', site, status: 'blocked', error: 'search_browser_challenge', url: page.url() });
        skipGoogle.add(site); continue;
      }
      const hits = await page.locator('a:has(h3)').evaluateAll(nodes => nodes.map(node => ({ title: node.querySelector('h3')?.innerText.trim(),
        search_result_url: node.href, displayed_source: node.querySelector('cite')?.innerText || '', snippet: (node.closest('.MjjYud')?.innerText || '').slice(0, 1200) })));
      pages.push({ url: page.url(), http_status: response?.status(), hits: hits.length, source: 'google_web' });
      if (!hits.length) {
        if (!/did not match any documents|no results found|没有找到|找不到与/i.test(text)) throw new Error('search_results_not_recognized');
        successfulSources.add('google_web:' + site); skipGoogle.add(site); continue;
      }
      successfulSources.add('google_web:' + site);
      for (const hit of hits) {
        if (!search.sites.some(site => hit.displayed_source.includes(site) || hit.search_result_url.includes(site))) continue;
        const resolved = await resolveResult(context, hit.search_result_url, search.sites, siteRegistry);
        if (!resolved || seen.has(resolved)) continue;
        seen.add(resolved);
        candidates.push({ ...hit, url: resolved, source: 'google_web', discovered_at: new Date().toISOString(), published_at: null,
          date_filter: search.from || search.to ? 'requires_article_publication_check' : 'not_requested' });
        if (candidates.length >= search.limit) break;
      }
      } catch (cause) {
        sourceErrors.push({ source: 'google_web', site, status: 'error', error: cause.message, url: page.url() });
        skipGoogle.add(site);
      }
      }
      if (!candidates.length && pages.some(item => item.hits)) warnings.push('no_supported_article_links_resolved');
      if (search.sites.every(site => skipGoogle.has(site))) break;
      if (round === 0 && !candidates.length && pages.some(item => item.hits)) break;
    }
    // Search engines sometimes return publisher navigation pages for a topic.
    // Fall back to the publisher's visible search UI, never its article payload.
    if (candidates.length < search.limit) {
      warnings.push('publisher_search_fallback_used');
      const query = search.query.replaceAll('"', '').trim();
      for (const site of search.sites) {
        if (candidates.length >= search.limit) break;
        const url = siteRegistry.find('https://' + site)?.searchUrl?.(query);
        if (!url) continue;
        try {
        // A failed navigation can commit chrome-error after goto rejects. Use
        // an independent page so that late failure cannot cancel this source.
        await page.close().catch(() => {}); page = await context.newPage();
        log?.(`Searching publisher ${site}: ${query}`);
        const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const ready = siteRegistry.find(url)?.searchReady;
        if (ready) await page.waitForFunction(ready, null, { timeout: 12000 }).catch(() => {});
        const text = await page.locator('body').innerText();
        const challenged = /unusual traffic|verify (that )?you are human|access to this page has been denied|please (enable|turn on) (js|javascript)/i.test(text)
          || /are you a robot|access denied/i.test(await page.title());
        await writeFile(join(out, `publisher-search-${site}.html`), await page.content());
        if (challenged) {
          warnings.push(`publisher_search_blocked:${site}`);
          sourceErrors.push({ source: 'publisher_search', site, status: 'blocked', error: 'publisher_search_browser_challenge', url: page.url() });
          continue;
        }
        if (response?.status() >= 400) throw new Error('publisher_search_http_' + response.status());
        const links = await page.locator('a[href]').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && node.innerText.trim().length > 15)
          .map(node => ({ title: node.innerText.trim().replace(/\s+/g, ' '), url: node.href })));
        pages.push({ url: page.url(), http_status: response?.status(), hits: links.length, source: 'publisher_search' });
        const recognized = links.some(link => articleCandidate(link.url, [site], siteRegistry)) || /no results|no matches|did not match|没有找到/i.test(text);
        if (!recognized) throw new Error('publisher_search_results_not_recognized');
        successfulSources.add('publisher_search:' + site);
        for (const link of links) {
          const resolved = articleCandidate(link.url, [site], siteRegistry);
          if (!resolved || seen.has(resolved)) continue;
          seen.add(resolved); candidates.push({ title: link.title, url: resolved, source: 'publisher_search', search_result_url: link.url,
            displayed_source: site, snippet: '', discovered_at: new Date().toISOString(), published_at: null,
            date_filter: search.from || search.to ? 'requires_article_publication_check' : 'not_requested' });
          if (candidates.length >= search.limit) break;
        }
        } catch (cause) {
          sourceErrors.push({ source: 'publisher_search', site, status: 'error', error: cause.message, url: page.url() });
        }
      }
    }
  } catch (cause) { status = 'error'; error = cause.message; }
  finally { await page.close().catch(() => {}); }
  if (sourceErrors.length) {
    warnings.push('some_discovery_sources_failed');
    if (!candidates.length && !successfulSources.size) {
      status = sourceErrors.every(item => item.status === 'blocked') ? 'blocked' : 'error';
      error = sourceErrors.at(-1).error;
    }
  }
  if (search.from || search.to) warnings.push('search_dates_are_hints_until_verified_against_article_metadata');
  if (candidates.length < search.limit) warnings.push('fewer_candidates_than_requested');
  const result = { status, query: search.query, sites: search.sites, from: search.from, to: search.to, requested_limit: search.limit,
    candidates, warnings: [...new Set(warnings)], error, source_errors: sourceErrors,
    source: candidates.some(item => item.source === 'publisher_search') ? 'google_web+publisher_search' : 'google_web', pages, searched_at: new Date().toISOString() };
  await writeFile(join(out, 'discovery.json'), JSON.stringify(result, null, 2));
  return result;
}
