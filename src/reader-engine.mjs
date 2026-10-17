import { join, resolve } from 'node:path';
import { readdir, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { projectRoot, verifyBpcAssets, pinBpcAssets, inspectBpcAssets, sameBpcAssets } from './bpc-assets.mjs';
import { startRuntime, stopRuntime, readArticle as acquireArticle, persistArticle, initializeRuntime } from './managed-reader.mjs';
import { ArticleCache, writeJson, readJson, acquireLease } from './reader-storage.mjs';
import { validateSession, validateArticleUrl, validateSearch, normalizeArticleUrl, publicationSelection, digest, adapterVersion, defaultDriver } from './reader-config.mjs';
import { discoverArticles } from './discovery.mjs';
import { getSiteAdaptations } from './site-adaptations.mjs';
import { workspaceId } from './reader-settings.mjs';
import { defaultSiteRegistry } from './site-registry.mjs';
import { discoverFeedArticles } from './feed-discovery.mjs';

const stamp = () => new Date().toISOString();
const jobId = () => new Date().toISOString().replace(/[-:.]/g, '') + '-' + randomUUID().slice(0, 8);
const validateId = id => { if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid job id'); };
function failure(url, error, folder) {
  return { url, status: 'error', completeness: 'unknown', reasons: ['runtime_or_capture_failed'], warnings: [], error: error.message,
    fetched_at: stamp(), content_markdown: '', content_text: '', content_sha256: null, metrics: { paragraphs: 0, text_chars: 0 }, artifact_dir: folder, runtime: null };
}
function summarize(job) {
  const results = job.items.filter(item => item.result).map(item => item.result);
  return { discovered: job.discovery?.candidates.length || 0, total: job.items.length, completed: results.length,
    ok: results.filter(r => r.status === 'ok').length, partial: results.filter(r => r.status === 'partial').length,
    blocked: results.filter(r => r.status === 'blocked').length, error: results.filter(r => r.status === 'error').length,
    cache_hits: results.filter(r => r.cache?.hit).length, accepted: job.items.filter(i => i.result?.status === 'ok' && i.selection?.accepted).length,
    filtered_out: job.items.filter(i => i.selection && !i.selection.accepted).length };
}

export class ReaderEngine {
  constructor({ session = 'reader', driver = defaultDriver, proxy, stateDir = join(projectRoot, '.cache/reader'), cacheTtlMs = 86400000, log = () => {}, runtimeFactory = startRuntime, siteRegistry = defaultSiteRegistry, bpcAssets = null } = {}) {
    validateSession(session);
    if (!['chromium', 'chromium-cdp'].includes(driver)) throw new Error('Managed runtime only supports bundled Chromium drivers');
    this.session = session; this.driver = driver; this.proxy = proxy; this.stateDir = resolve(stateDir); this.log = log;
    this.cache = new ArticleCache(join(this.stateDir, 'cache'), cacheTtlMs);
    this.runtimeFactory = runtimeFactory;
    this.bpcAssets = bpcAssets; // Internal, fixed receipt for isolated upgrade validation.
    this.siteRegistry = siteRegistry; this.siteRulesReceipt = getSiteAdaptations(siteRegistry).siteRulesReceipt;
    this.tail = Promise.resolve(); this.pending = new Map();
  }
  jobFile(id) { validateId(id); return join(this.stateDir, 'jobs', id + '.json'); }
  sessionKey() { return resolve(projectRoot).toLowerCase() + ':' + this.driver + ':' + this.session; }
  async getJob(id) { return await readJson(this.jobFile(id)); }
  async listJobs() {
    const files = await readdir(join(this.stateDir, 'jobs')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const jobs = await Promise.all(files.filter(file => file.endsWith('.json')).map(file => readJson(join(this.stateDir, 'jobs', file))));
    return jobs.filter(job => job.session === this.session && job.driver === this.driver).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(({ id, state, phase, created_at, updated_at, summary, artifact_dir }) => ({ id, state, phase, created_at, updated_at, summary, artifact_dir }));
  }
  async save(job) { job.updated_at = stamp(); job.summary = summarize(job); await writeJson(this.jobFile(job.id), job); }
  async createJob({ urls, search, read = true, refresh = false, interactive = false, timeoutMs = interactive ? 600000 : 90000, out } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 10000 || timeoutMs > (interactive ? 600000 : 180000)) throw new Error('Invalid timeoutMs for this reading mode');
    if (search && urls) throw new Error('Supply URLs or search conditions, not both');
    const id = jobId(), items = [], seen = new Set();
    if (!search) {
      if (!Array.isArray(urls) || !urls.length || urls.length > 100) throw new Error('Supply 1 to 100 article URLs');
      for (const input of urls) {
        const item = typeof input === 'string' ? { url: input } : input;
        validateArticleUrl(item?.url, this.siteRegistry);
        const key = normalizeArticleUrl(item.url, this.siteRegistry) + ':' + digest(item.expected || null);
        if (seen.has(key)) continue;
        seen.add(key); items.push({ url: item.url, expected: item.expected, state: 'queued' });
      }
    }
    const job = { schema: 1, id, session: this.session, driver: this.driver, state: 'queued', phase: 'queued', created_at: stamp(),
      request: { search: search ? validateSearch(search, this.siteRegistry) : null, read, refresh, interactive, timeoutMs },
      input_count: search ? 0 : urls.length, duplicates_removed: search ? 0 : urls.length - items.length,
      items, artifact_dir: resolve(out || join(projectRoot, 'output/reader', id)) };
    await this.save(job); return job;
  }
  async enqueue(request) {
    const job = await this.createJob(request);
    return { job, completion: this.runJob(job.id) };
  }
  runJob(id, { retryFailed = false } = {}) {
    validateId(id);
    if (this.pending.has(id)) return this.pending.get(id);
    const completion = this.tail.then(() => this.execute(id, retryFailed));
    this.tail = completion.catch(() => {});
    this.pending.set(id, completion);
    completion.finally(() => this.pending.delete(id)).catch(() => {});
    return completion;
  }
  async execute(id, retryFailed) {
    const releaseJob = await acquireLease(this.stateDir.toLowerCase() + ':job:' + id);
    let job, releaseSession, runtime, assets, started = false;
    const runtimes = [];
    const acquire = async () => {
      if (runtime && !runtime.context.browser()?.isConnected()) runtime = null;
      if (!runtime) { runtime = await this.runtimeFactory({ session: this.session, driver: this.driver, proxy: this.proxy, log: this.log, siteRegistry: this.siteRegistry, bpcAssets: assets }); runtimes.push(runtime); job.active_runtime = runtime.info; await this.save(job); }
      return runtime;
    };
    try {
      job = await this.getJob(id);
      if (job.session !== this.session || job.driver !== this.driver) throw new Error('Resume with the original session and driver');
      if (job.state === 'completed' && !retryFailed) return job;
      started = true;
      if (retryFailed) for (const item of job.items) if (item.result?.status !== 'ok') { item.state = 'queued'; delete item.result; }
      for (const item of job.items) if (item.state === 'running') item.state = 'queued';
      job.state = 'running'; job.phase = 'waiting_for_session'; job.worker_pid = process.pid; delete job.error;
      await this.save(job);
      releaseSession = await acquireLease(this.sessionKey(), { onWait: () => this.log('Dedicated session busy; waiting in queue...') });
      assets = this.bpcAssets || await pinBpcAssets();
      if (this.bpcAssets && !sameBpcAssets(await inspectBpcAssets(assets.runtime_path), assets)) throw new Error('Explicit BPC pin failed integrity verification');
      if (job.request.search && (!job.discovery || job.discovery.status !== 'ok')) {
        job.phase = 'searching'; await this.save(job);
        job.discovery = await discoverArticles((await acquire()).context, job.request.search, { out: join(job.artifact_dir, 'search'), log: this.log,
          interactive: job.request.interactive, timeoutMs: job.request.timeoutMs, siteRegistry: this.siteRegistry,
          onState: async phase => { job.phase = phase; await this.save(job); } });
        if (job.discovery.status !== 'ok') throw new Error(job.discovery.error || 'Search failed');
        job.items = job.request.read ? job.discovery.candidates.map(hit => ({ url: hit.url, discovery: hit, state: 'queued' })) : [];
        await this.save(job);
      }
      for (const [index, item] of job.items.entries()) {
        if (item.state === 'completed') continue;
        const folder = join(job.artifact_dir, `${String(index + 1).padStart(3, '0')}-${digest(normalizeArticleUrl(item.url, this.siteRegistry)).slice(0, 10)}`);
        job.phase = 'reading'; item.state = 'running'; item.started_at = stamp(); await this.save(job);
        this.log(`[${index + 1}/${job.items.length}] ${item.url}`);
        const key = digest({ url: normalizeArticleUrl(item.url, this.siteRegistry), session: this.sessionKey(), adapter: adapterVersion, bpc: assets.sha256, site_rules: this.siteRulesReceipt.sha256, expected: item.expected || null });
        try {
          const cached = await this.cache.get(key, { refresh: job.request.refresh });
          if (cached.hit) {
            const { result: source, ...receipt } = cached;
            item.result = { ...source, url: item.url, artifact_dir: folder, runtime: null, source_runtime: source.runtime,
              served_at: stamp(), cache: { ...receipt, source_artifact_dir: source.artifact_dir } };
            this.log('Cache hit; no article navigation.');
          } else {
            item.result = await acquireArticle({ url: item.url, expected: item.expected, out: folder,
              session: this.session, timeoutMs: job.request.timeoutMs, interactive: job.request.interactive, siteRegistry: this.siteRegistry,
              runtime: await acquire(), log: this.log, onState: async state => {
                const phase = job.request.interactive && state.state === 'challenge' ? 'waiting_for_site_verification' : 'reading';
                if (job.phase !== phase) { job.phase = phase; await this.save(job); }
              } });
            item.result.cache = { ...cached, key };
          }
          item.cache_key = key;
        } catch (error) { item.result = failure(item.url, error, folder); }
        item.selection = publicationSelection(item.result, job.request.search || {});
        item.state = 'completed'; item.finished_at = stamp();
        await persistArticle(item.result); await this.save(job);
      }
      job.state = 'completed'; job.phase = 'completed'; job.finished_at = stamp();
    } catch (error) {
      if (!job || !started) throw error;
      job.state = 'failed'; job.phase = 'failed'; job.error = error.message;
    } finally {
      try {
        for (const active of runtimes) await stopRuntime(active);
        if (job && started) {
          job.browser_launches = runtimes.map(active => active.info);
          for (const item of job.items) if (item.result) {
            await persistArticle(item.result);
            if (!item.result.cache?.hit && item.cache_key) await this.cache.put(item.cache_key, item.result);
          }
          await this.save(job);
          await writeJson(join(job.artifact_dir, 'summary.json'), job);
        }
      } finally { await releaseSession?.(); await releaseJob(); }
    }
    return job;
  }
  async readArticle({ url, expected, ...options }) {
    const { completion } = await this.enqueue({ ...options, urls: [{ url, expected }] });
    const job = await completion;
    if (!job.items[0]?.result) throw new Error(job.error || 'Reading job did not produce an article');
    return { ...job.items[0].result, job_id: job.id };
  }
  async batch(options) { return await (await this.enqueue(options)).completion; }
  async searchArticles(search, options = {}) { return await this.batch({ ...options, search, read: false }); }
  async discoverFeedArticles(input, { out } = {}) {
    return await discoverFeedArticles(input, { siteRegistry: this.siteRegistry, proxy: this.proxy, out });
  }
  async initialize() {
    const release = await acquireLease(this.sessionKey());
    try { return await initializeRuntime({ session: this.session, driver: this.driver, proxy: this.proxy, log: this.log, siteRegistry: this.siteRegistry }); }
    finally { await release(); }
  }
  async health() {
    const bpc = await verifyBpcAssets();
    const { chromium } = await import('playwright');
    let browserInstalled = true;
    try { await access(chromium.executablePath()); } catch { browserInstalled = false; }
    return { app_id: 'bpc-reader', workspace_id: workspaceId, pid: process.pid, proxy_host: this.proxy ? new URL(this.proxy).host : null,
      status: browserInstalled ? 'ready' : 'setup_required', session: this.session, driver: this.driver, browser_installed: browserInstalled,
      bpc_version: bpc.version, queued_or_running: this.pending.size, cache_ttl_ms: this.cache.ttlMs, state_dir: this.stateDir };
  }
}
