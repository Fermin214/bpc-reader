import { fileURLToPath } from 'node:url';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { observePage, collectCommonPageFacts } from './page-state.mjs';
import { getSiteAdaptations } from './site-adaptations.mjs';
import { defaultSiteRegistry } from './site-registry.mjs';
import { startNativeChrome } from './native-chrome.mjs';
import { pinBpcAssets } from './bpc-assets.mjs';

process.env.PLAYWRIGHT_BROWSERS_PATH ||= fileURLToPath(new URL('../.cache/browsers', import.meta.url));
const { chromium } = await import('playwright');
export const defaultExtension = fileURLToPath(new URL('../vendor/bpc', import.meta.url));
const delay = ms => new Promise(done => setTimeout(done, ms));
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function fingerprint(folder) {
  const files = [];
  async function visit(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      const path = join(dir, item.name);
      if (item.isDirectory()) await visit(path);
      else if (item.isFile()) files.push(path);
    }
  }
  await visit(folder);
  const hash = createHash('sha256');
  for (const path of files.sort()) { hash.update(relative(folder, path)); hash.update(await readFile(path)); }
  return hash.digest('hex');
}

export async function launch({ mode = 'baseline', extension, headed = false, proxy, profile, browser = 'chromium', siteRegistry = defaultSiteRegistry } = {}) {
  const domains = siteRegistry.bpcDomains;
  const { localSiteRules, siteRulesReceipt } = getSiteAdaptations(siteRegistry);
  const requiredActions = Object.fromEntries(Object.values(localSiteRules).map(rule => [rule.domain, rule.cs_code?.length || 0]));
  if (!['chromium', 'chromium-cdp', 'chrome', 'chrome-cdp'].includes(browser)) throw new Error('browser must be chromium, chromium-cdp, chrome or chrome-cdp');
  if (!['chromium', 'chromium-cdp'].includes(browser) && mode === 'bpc') throw new Error('Use bundled Chromium for side-loaded BPC; system Chrome is supported for baseline sessions.');
  if (browser.endsWith('-cdp') && (!profile || !headed)) throw new Error('Native browser startup requires --headed and a dedicated --profile name');
  if (profile && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(profile)) throw new Error('profile must be a short name, not a path');
  let profilePath = '', profileInfo = null;
  if (profile) {
    profilePath = fileURLToPath(new URL(`../.cache/profiles/${browser}-${mode}-${profile}/`, import.meta.url));
    await mkdir(profilePath, { recursive: true });
    const markerPath = join(profilePath, 'reading-poc-profile.json');
    try { profileInfo = JSON.parse(await readFile(markerPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      profileInfo = { id: randomUUID(), created_at: new Date().toISOString() };
      const { writeFile } = await import('node:fs/promises');
      await writeFile(markerPath, JSON.stringify(profileInfo, null, 2));
    }
  }
  const extensionPath = resolve(extension || (mode === 'bpc' ? (await pinBpcAssets()).runtime_path : defaultExtension));
  const manifest = mode === 'bpc' ? JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8')) : null;
  if (manifest && manifest.manifest_version !== 3) throw new Error('BPC-Reader requires BPC Manifest V3.');
  let native;
  const context = browser.endsWith('-cdp') ? (native = await startNativeChrome({ chromium, profilePath, proxy,
    ...(browser === 'chromium-cdp' ? { executablePath: chromium.executablePath(), extensionPath: manifest ? extensionPath : undefined } : {}) })).context : await chromium.launchPersistentContext(profilePath, {
    channel: browser, headless: !headed, timeout: 20000, viewport: { width: 1440, height: 1000 },
    ...(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {}),
    args: mode === 'bpc' ? [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] : [],
  });
  const close = native ? native.close : () => context.close();
  try {
    const info = { mode, browser: context.browser()?.version(), browser_channel: browser, headed,
      launch_id: randomUUID(), profile: profileInfo ? { ...profileInfo, path: profilePath, name: profile } : null,
      proxy: proxy ? new URL(proxy).host : null, extension: null };
    if (native) info.native_process = { pid: native.pid, endpoint: native.endpoint, executable: native.executable,
      args: native.args.map(arg => arg.startsWith('--proxy-server=') ? `--proxy-server=${new URL(proxy).protocol}//${new URL(proxy).host}` : arg) };
    let activateBpc;
    if (manifest) {
      // A fresh Chromium profile also starts component extension workers (for
      // example Hangouts). Identify BPC rather than taking the first worker.
      const extensionId = manifest.key ? [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)]
        .map(byte => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('') : null;
      const discoveryDeadline = Date.now() + 15000;
      let worker;
      do {
        for (const candidate of context.serviceWorkers()) {
          if (extensionId ? !candidate.url().startsWith(`chrome-extension://${extensionId}/`)
            : !candidate.url().endsWith('/' + manifest.background.service_worker)) continue;
          const identity = await bounded(candidate.evaluate(() => ({ name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version })), 2500, 'BPC identity').catch(() => null);
          if (identity?.name === manifest.name && identity.version === manifest.version) { worker = candidate; break; }
        }
        if (!worker) await delay(100);
      } while (!worker && Date.now() < discoveryDeadline);
      if (!worker) throw new Error('Bundled BPC service worker was not found.');
      const deadline = Date.now() + 15000;
      while (!(await bounded(worker.evaluate(() => typeof defaultSites !== 'undefined' && typeof enabledSites !== 'undefined'), 5000, 'BPC initialization'))) {
        if (Date.now() > deadline) throw new Error('BPC service worker did not initialize.');
        await delay(100);
      }
      // Let first-install defaults finish, then enable the registered BPC sites.
      await delay(1500);
      await bounded(worker.evaluate(async ({ allowed, updates }) => {
        const sites = Object.fromEntries(Object.entries(defaultSites).filter(([, value]) => allowed.includes(value.domain)).map(([name, value]) => [name, value.domain]));
        await chrome.storage.local.set({ sites, optInUpdate: false, optInFetch: false, sites_updated: updates, ext_update_check: Date.now() });
      }, { allowed: domains, updates: localSiteRules }), 5000, 'BPC configuration');
      let snapshot;
      do {
        await delay(200);
        snapshot = await bounded(worker.evaluate(async domains => ({ enabled: enabledSites, rules: (await chrome.declarativeNetRequest.getSessionRules()).length,
          local_actions: Object.fromEntries(domains.map(domain => [domain, cs_code[domain]?.length || 0])) }), Object.keys(requiredActions)), 5000, 'BPC rules');
        if (Date.now() > deadline) throw new Error(`BPC sites/rules did not become ready: ${JSON.stringify(snapshot)}`);
      } while (!domains.every(domain => snapshot.enabled.includes(domain)) || !snapshot.rules
        || Object.entries(requiredActions).some(([domain, count]) => snapshot.local_actions[domain] !== count));
      info.extension = { id: worker.url().split('/')[2], version: manifest.version, manifest_version: manifest.manifest_version,
        source_path: extensionPath, source_sha256: await fingerprint(extensionPath), enabled_domains: snapshot.enabled,
        session_rules: snapshot.rules, remote_rule_updates: false, external_fetch_opt_in: false, local_site_rules: { ...siteRulesReceipt, applied_actions: Object.values(snapshot.local_actions).reduce((sum, count) => sum + count, 0) } };
      // BPC normally starts on tabs.onUpdated(complete). Pending third-party
      // resources can delay that event indefinitely. Use its own pinned native
      // lifecycle after the publisher DOM is ready, respecting per-site toggles.
      activateBpc = url => bounded(worker.evaluate(async url => {
        const tabs = (await chrome.tabs.query({})).filter(tab => tab.url === url);
        if (tabs.length !== 1) return { invoked: false, reason: 'ambiguous_tab' };
        if (!isSiteEnabled(tabs[0])) return { invoked: false, reason: 'site_disabled' };
        runOnTab(tabs[0]);
        return { invoked: true, reason: 'publisher_dom_ready', tab_id: tabs[0].id };
      }, url), 5000, 'BPC native lifecycle');
    }
    // A visible persistent Chrome exits when its final tab is closed. Keep an
    // about:blank anchor across individual captures and close it with the context.
    const anchor = context.pages().find(page => page.url() === 'about:blank') || await context.newPage();
    for (const page of context.pages()) if (page !== anchor) await bounded(page.close(), 5000, 'close startup tab').catch(() => {});
    return { context, info, close, activateBpc };
  } catch (error) { await close(); throw error; }
}

export async function capture(context, url, { timeout = 30000, settle = 0, readyTimeout = 45000, keepPage = false, onState, activateBpc, siteRegistry = defaultSiteRegistry,
  signal, deadline = Infinity, artifactBudgetMs = 0 } = {}) {
  const started = Date.now();
  const diagnostics = { page_errors: [], failed_requests: [], navigation_error: null };
  let page, closing, finished = false, succeeded = false;
  const closePage = () => closing ||= page?.close().catch(() => {});
  const abort = () => { closePage(); };
  signal?.throwIfAborted();
  signal?.addEventListener('abort', abort, { once: true });
  const run = async (promise, ms, label) => {
    const remaining = Math.min(ms, deadline - Date.now());
    if (signal?.aborted) { Promise.resolve(promise).catch(() => {}); signal.throwIfAborted(); }
    if (remaining <= 0) { Promise.resolve(promise).catch(() => {}); throw new Error('read_timeout'); }
    let onAbort;
    try {
      return await bounded(Promise.race([promise, new Promise((_, reject) => {
        onAbort = () => reject(signal.reason || new Error('read_timeout'));
        signal?.addEventListener('abort', onAbort, { once: true });
      })]), remaining, label);
    } finally { signal?.removeEventListener('abort', onAbort); }
  };
  const documents = [];
  try {
  // Also close a late newPage result if its caller has already timed out.
  const pendingPage = context.newPage().then(created => { page = created; if (finished || signal?.aborted || Date.now() >= deadline) closePage(); return created; });
  page = await run(pendingPage, 10000, 'new page');
  page.on('pageerror', error => { if (diagnostics.page_errors.length < 10) diagnostics.page_errors.push(error.message); });
  page.on('requestfailed', request => { if (diagnostics.failed_requests.length < 30) diagnostics.failed_requests.push({ url: request.url(), error: request.failure()?.errorText }); });
  page.on('response', response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) documents.push(response);
  });
    const readyUntil = Math.min(Date.now() + timeout + readyTimeout, deadline - artifactBudgetMs);
    try { await run(page.goto(url, { waitUntil: 'commit', timeout: Math.max(1, Math.min(timeout, readyUntil - Date.now())) }), timeout, 'navigation'); }
    catch (error) { diagnostics.navigation_error = error.message; }
    const waitStarted = Date.now();
    const transitions = [];
    let observation = null, stable = 0, previousSignature = '', publisherState;
    const activation = [];
    do {
      if (page.isClosed()) throw new Error('Capture page was closed');
      try {
        const site = siteRegistry.find(page.url());
        publisherState = site?.inspectPublisher
          ? await run(page.evaluate(site.inspectPublisher), 2500, 'publisher body state') : null;
        const common = await run(page.evaluate(collectCommonPageFacts), 2500, 'common page facts');
        const facts = site?.collectFacts ? await run(page.evaluate(site.collectFacts, { common, publisher: publisherState }), 2500, 'publisher page facts') : common;
        observation = observePage(facts);
        diagnostics.readiness = observation;
        if (activateBpc && site?.shouldActivateBpc?.({ observation, publisher: publisherState, attempts: activation.length, elapsed: Date.now() - waitStarted })) {
          activation.push({ elapsed_ms: Date.now() - waitStarted, ...await run(activateBpc(page.url()), 5000, 'BPC lifecycle') });
        }
        const last = transitions.at(-1);
        if (!last || last.state !== observation.state) {
          transitions.push({ state: observation.state, elapsed_ms: Date.now() - waitStarted });
          if (onState) await run(onState({ observation, page }), Number.isFinite(deadline) ? Math.max(1, deadline - Date.now()) : 30000, 'state notification');
        }
        const signature = `${observation.state}:${observation.body_chars}:${observation.paragraphs}`;
        stable = signature === previousSignature ? stable + 1 : 0;
        previousSignature = signature;
        if (observation.state === 'navigation_error') break;
        const minimumWait = site?.minimumWait?.({ observation, publisher: publisherState, settle }) ?? settle;
        if (['article_ready', 'partial_preview'].includes(observation.state) && stable >= 2 && Date.now() - waitStarted >= minimumWait) break;
        // A stable, long body with no supported completion proof is diagnostic
        // partial content. It must not consume a human-verification budget.
        if (observation.state === 'loading' && observation.body_chars >= 600 && stable >= 6
          && Date.now() - waitStarted >= Math.max(15000, minimumWait)) {
          diagnostics.stop_reason = 'stable_incomplete_template'; break;
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) throw new Error('read_timeout');
        diagnostics.last_observation_error = error.message;
        // The page can reload while a device check completes.
      }
      await delay(350);
    } while (Date.now() - waitStarted < readyTimeout && Date.now() < readyUntil);
    signal?.throwIfAborted();
    diagnostics.readiness = { ...observation, transitions, elapsed_ms: Date.now() - waitStarted,
      timed_out: !['article_ready', 'partial_preview', 'navigation_error'].includes(observation?.state) };
    if (activation.length) diagnostics.bpc_lifecycle = activation;
    const response = documents.at(-1);
    let rawHtml = '';
    if (response) {
      try { rawHtml = await run(response.text(), 1500, 'response body'); } catch (error) { diagnostics.raw_html_error = error.message; }
    }
    const renderedHtml = await run(page.content(), 2500, 'rendered HTML');
    const adapter = siteRegistry.find(page.url());
    if (adapter?.validateStructure) {
      const structure = adapter.validateStructure({ rawHtml, publisher: publisherState });
      if (structure) {
        publisherState = { ...publisherState, initial_structure: structure, complete: publisherState.complete && structure.satisfied !== false };
        observation = { ...observation, publisher_body: publisherState };
        diagnostics.readiness = { ...diagnostics.readiness, publisher_body: publisherState };
      }
    }
    const articleHtml = adapter?.exportDocument && ['article_ready', 'partial_preview'].includes(observation?.state)
      ? await run(page.evaluate(adapter.exportDocument, publisherState), 2500, 'visible article').catch(() => null) : null;
    const siteEvidence = adapter ? { site_id: adapter.id, extraction_scope: adapter.scope,
      body_exported: !!articleHtml, observation_matches_url: observation?.url === page.url(),
      visible_paywall: observation?.visible_paywall,
      completion: observation && adapter.completionEvidence ? adapter.completionEvidence(observation) : null } : null;
    if (siteEvidence) diagnostics.site_evidence = siteEvidence;
    const publisherAccess = await run(page.evaluate(() => {
      const flags = [];
      const walk = value => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (!value || typeof value !== 'object') return;
        if (/Article|Reportage/.test(String(value['@type'])) && 'isAccessibleForFree' in value) flags.push(value.isAccessibleForFree);
        if (value['@graph']) walk(value['@graph']);
      };
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) { try { walk(JSON.parse(script.textContent)); } catch {} }
      return flags;
    }), 2500, 'publisher metadata').catch(() => []);
    signal?.throwIfAborted();
    const screenshot = await run(page.screenshot({ fullPage: false, timeout: 2000 }), 2000, 'screenshot').catch(() => null);
    signal?.throwIfAborted();
    succeeded = true;
    return { rawHtml, renderedHtml, articleHtml, screenshot, siteEvidence, extraction_scope: articleHtml ? adapter.scope : 'rendered_document_readability',
      publisher_accessible_for_free: publisherAccess, page: keepPage ? page : undefined, final_url: page.url(), http_status: response?.status() ?? null,
      navigation: documents.map(item => ({ url: item.url(), status: item.status() })),
      elapsed_ms: Date.now() - started, diagnostics };
  } catch (error) {
    if (Date.now() >= deadline && !signal?.aborted) error = new Error('read_timeout');
    error.captureDiagnostics = { ...diagnostics, navigation: documents.map(item => ({ url: item.url(), status: item.status() })) };
    throw error;
  } finally {
    finished = true;
    if (!keepPage || !succeeded || signal?.aborted) await bounded(Promise.resolve(closePage()), 3000, 'close page').catch(() => {});
    signal?.removeEventListener('abort', abort);
  }
}
