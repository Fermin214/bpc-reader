import { access, mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectRoot, pinBpcAssets, inspectBpcAssets, sameBpcAssets } from './bpc-assets.mjs';
import { launch, capture } from './browser.mjs';
import { extract, extractMetadata } from './extract.mjs';
import { validateSession, validateArticleUrl, defaultDriver } from './reader-config.mjs';
import { defaultSiteRegistry } from './site-registry.mjs';


export async function prepareRuntime({ log = () => {}, proxy, bpcAssets } = {}) {
  const assets = bpcAssets || await pinBpcAssets();
  if (!assets.runtime_path || !sameBpcAssets(await inspectBpcAssets(assets.runtime_path), assets)) throw new Error('BPC runtime pin does not match its resource receipt');
  const { chromium } = await import('playwright');
  const executable = chromium.executablePath();
  try { await access(executable); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    log('Preparing the tool-managed Chromium runtime...');
    const child = spawn(process.execPath, [join(projectRoot, 'node_modules/playwright/cli.js'), 'install', 'chromium', '--no-shell'], {
      cwd: projectRoot, env: { ...process.env, ...(proxy ? { HTTP_PROXY: proxy, HTTPS_PROXY: proxy } : {}) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => process.stderr.write(chunk));
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done); });
    if (code !== 0) throw new Error(`Chromium setup failed (${code})`);
    await access(executable);
  }
  return { assets, executable };
}

export async function startRuntime({ session, proxy, driver = defaultDriver, log, siteRegistry, bpcAssets }) {
  validateSession(session);
  if (!['chromium', 'chromium-cdp'].includes(driver)) throw new Error('Managed runtime only supports bundled Chromium drivers');
  const resources = await prepareRuntime({ log, proxy, bpcAssets });
  const runtime = await launch({ mode: 'bpc', browser: driver, profile: session, headed: true, proxy, siteRegistry, extension: resources.assets.runtime_path });
  runtime.info.managed = true;
  runtime.info.daily_chrome_used = false;
  runtime.info.opencli_used = false;
  runtime.info.bundled_asset = resources.assets;
  runtime.info.executable = resources.executable;
  return runtime;
}

export async function stopRuntime(runtime) {
  const closed = await runtime.close();
  runtime.info.closed_at = new Date().toISOString();
  runtime.info.browser_disconnected = !runtime.context.browser()?.isConnected();
  if (runtime.info.native_process && closed) Object.assign(runtime.info.native_process, closed);
}

export async function initializeRuntime({ session = 'reader', proxy, driver, log, siteRegistry } = {}) {
  const runtime = await startRuntime({ session, proxy, driver, log, siteRegistry });
  try { return { status: 'ready', runtime: runtime.info }; }
  finally {
    await stopRuntime(runtime);
  }
}

export async function readArticle({ url, session = 'reader', proxy, driver, timeoutMs = 90000, interactive = false, expected, out, log, runtime: providedRuntime, onState, settleMs = 0, siteRegistry = defaultSiteRegistry } = {}) {
  validateArticleUrl(url, siteRegistry);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10000 || timeoutMs > (interactive ? 600000 : 180000)) throw new Error('Invalid timeoutMs for this reading mode');
  validateSession(session);
  const folder = resolve(out || join(projectRoot, 'output/reader', `${Date.now()}-${randomUUID().slice(0, 8)}`));
  await mkdir(folder, { recursive: true });
  let runtime = providedRuntime, result, timer, interaction;
  const controller = new AbortController();
  const started = Date.now();
  try {
    runtime ||= await startRuntime({ session, proxy, driver, log, siteRegistry });
    log?.(`Dedicated Chromium ready; bundled BPC ${runtime.info.extension.version}`);
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    timer = setTimeout(() => controller.abort(new Error('read_timeout')), remaining);
    const acquired = await capture(runtime.context, url, { timeout: Math.min(30000, remaining), settle: settleMs,
      readyTimeout: interactive ? remaining : Math.min(45000, remaining), signal: controller.signal,
      deadline: started + timeoutMs - Math.min(1500, remaining * 0.1), artifactBudgetMs: Math.min(10000, remaining * 0.25),
      activateBpc: runtime.activateBpc, siteRegistry,
        onState: async ({ observation, page }) => {
          await onState?.(observation);
          if (interactive && observation.state === 'challenge') {
            interaction = { state: 'waiting_for_site_verification', url, requested_at: new Date().toISOString(),
              session, profile: runtime.info.profile?.path || null, browser_pid: runtime.info.native_process?.pid, daily_chrome_used: false };
            await writeFile(join(folder, 'interaction-required.json'), JSON.stringify(interaction, null, 2));
            await page.screenshot({ path: join(folder, 'page.png'), timeout: 5000 }).catch(() => {});
            log?.('The dedicated browser is waiting for the site verification. Complete it in that window; this command will continue automatically.');
          }
        } });
    clearTimeout(timer);
    const extractionUrl = acquired.final_url.startsWith('https:') ? acquired.final_url : url;
    const metadata = extractMetadata(acquired.renderedHtml, { url: extractionUrl });
    const extracted = extract(acquired.articleHtml || acquired.renderedHtml, { url: extractionUrl, httpStatus: acquired.http_status || 0, expected });
    result = {
      url, final_url: acquired.final_url, fetched_at: new Date().toISOString(), method: 'managed_chromium_bpc',
      ...extracted,
      published_at: extracted.published_at || metadata.published_at,
      author: extracted.author || metadata.author,
      language: extracted.language || metadata.language,
      http_status: acquired.http_status, readiness: acquired.diagnostics.readiness, extraction_scope: acquired.extraction_scope,
      publisher_accessible_for_free: acquired.publisher_accessible_for_free,
      navigation: acquired.navigation, diagnostics: acquired.diagnostics,
    };
    if (result.readiness?.state === 'challenge') { result.status = 'blocked'; result.reasons.push('browser_challenge'); }
    else if (!acquired.http_status || result.readiness?.state === 'navigation_error') { result.status = 'error'; result.reasons.push('navigation_failed'); }
    else if (!['blocked', 'error'].includes(result.status)) {
      const evidence = acquired.siteEvidence;
      const verified = evidence?.site_id === siteRegistry.find(acquired.final_url)?.id
        && evidence?.extraction_scope === result.extraction_scope && evidence?.body_exported === true
        && evidence?.observation_matches_url === true && evidence?.visible_paywall === false
        && evidence?.completion?.satisfied === true;
      if (result.readiness?.state !== 'article_ready' || !acquired.articleHtml || !verified) {
        result.status = 'partial'; result.reasons.push(result.readiness?.state === 'partial_preview' ? 'visible_preview' : 'article_end_not_observed');
        result.completeness = 'unknown';
      } else if (result.status === 'unverified') {
        result.status = 'ok'; result.completeness = 'publisher_end_observed';
        result.warnings = result.warnings.filter(warning => warning !== 'full_text_not_verified');
      }
    }
    if (['blocked', 'error'].includes(result.status)) {
      result.content_markdown = ''; result.content_text = ''; result.content_sha256 = null;
      result.metrics.text_chars = 0; result.metrics.paragraphs = 0; result.completeness = 'unknown';
    }
    if (result.status === 'ok' && result.readiness?.publisher_body?.non_text_tables) result.warnings.push('non_text_tables_not_exported');
    if (result.readiness?.publisher_body?.template_id === 'feature_ds_main_v1') {
      result.warnings.push('feature_text_only', 'feature_completeness_cannot_prove_no_missing_middle');
      if (result.readiness.publisher_body.omitted_visual_components) result.warnings.push('feature_visual_components_and_captions_not_exported');
      if (result.readiness.publisher_body.omitted_transparent_callouts) result.warnings.push('feature_transparent_display_callouts_not_exported');
      if (!result.readiness.publisher_body.initial_structure?.available) result.warnings.push('feature_initial_structure_unavailable');
    }
    await writeFile(join(folder, 'rendered.html'), acquired.renderedHtml);
    if (acquired.articleHtml) await writeFile(join(folder, 'extraction.html'), acquired.articleHtml);
    if (acquired.screenshot) await writeFile(join(folder, 'page.png'), acquired.screenshot);
  } catch (error) {
    result = { url, fetched_at: new Date().toISOString(), method: 'managed_chromium_bpc', status: 'error', completeness: 'unknown',
      reasons: [error.message === 'read_timeout' || controller.signal.aborted ? 'read_timeout' : 'runtime_or_capture_failed'], warnings: [], error: error.message,
      diagnostics: error.captureDiagnostics || null, readiness: error.captureDiagnostics?.readiness || null,
      content_markdown: '', content_text: '', content_sha256: null, metrics: { text_chars: 0, paragraphs: 0 } };
  } finally {
    clearTimeout(timer);
    if (runtime && !providedRuntime) {
      await stopRuntime(runtime);
    }
  }
  result.runtime = runtime?.info || null;
  result.elapsed_ms = Date.now() - started;
  result.artifact_dir = folder;
  if (interaction) await writeFile(join(folder, 'interaction-required.json'), JSON.stringify({ ...interaction,
    state: result.status === 'ok' ? 'completed' : 'closed_without_article', finished_at: new Date().toISOString(), result_status: result.status }, null, 2));
  await persistArticle(result);
  return result;
}

export async function persistArticle(result) {
  await mkdir(result.artifact_dir, { recursive: true });
  await writeFile(join(result.artifact_dir, 'article.json'), JSON.stringify(result, null, 2));
  await writeFile(join(result.artifact_dir, 'article.md'), `# ${result.title || result.url}\n\nSource: ${result.url}\n\nStatus: ${result.status} | Completeness: ${result.completeness}\n\n${result.content_markdown}\n`);
}
