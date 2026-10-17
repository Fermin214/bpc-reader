import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { ReaderEngine } from '../src/reader-engine.mjs';
import { launch } from '../src/browser.mjs';
import { writeJson } from '../src/reader-storage.mjs';
import { articleForModel } from '../src/reader-mcp.mjs';
import { parseArgs } from 'node:util';
import { inspectBpcAssets } from '../src/bpc-assets.mjs';

// Original fixture text; no publisher content or network requests are used.
// A deliberately pending image prevents the load event, reproducing the real
// Bloomberg race instead of testing a hand-built final DOM.
const { values } = parseArgs({ options: { extension: { type: 'string' }, out: { type: 'string' } } });
const candidate = values.extension ? resolve(values.extension) : null;
const candidateReceipt = candidate ? { ...await inspectBpcAssets(candidate), path: candidate, runtime_path: candidate } : null;
const root = resolve(values.out || 'output/playwright/publisher-smoke-' + Date.now());
const session = 'publisher-fixture-' + process.pid;
const paragraphs = Array.from({ length: 6 }, (_, i) => `Publisher fixture paragraph ${i + 1}. This original test text checks that a delayed browser extension can render every editorial paragraph in its original order. The reader must wait for the real article boundary and exclude captions, recommendations and promotional overlays.`);
const textBlock = (type, text) => ({ type, content: [{ type: 'text', value: text }] });
const blocks = [textBlock('paragraph', paragraphs[0]), { type: 'ad' }, textBlock('paragraph', paragraphs[1]),
  { type: 'media', subType: 'photo', data: { photo: { src: '/photo.png', caption: 'EXCLUDE_PHOTO_CAPTION', credit: 'FIXTURE' } } },
  textBlock('heading', 'Original fixture heading'), ...paragraphs.slice(2).map(text => textBlock('paragraph', text)),
  textBlock('paragraph', 'Read More: EXCLUDE_RECOMMENDATION'), { type: 'tabularData' }];
const model = { props: { pageProps: { story: { body: { content: blocks } } } } };
let releaseResource = () => {};
const profile = resolve('.cache/profiles/chromium-bpc-' + session);
const profileRoot = resolve('.cache/profiles');
const engine = new ReaderEngine({ session, driver: 'chromium', stateDir: join(root, 'state'), bpcAssets: candidateReceipt, runtimeFactory: async ({ bpcAssets }) => {
  let release;
  const pendingResource = new Promise(done => { release = done; });
  releaseResource = release;
  const runtime = await launch({ mode: 'bpc', browser: 'chromium', profile: session, extension: bpcAssets.runtime_path });
  runtime.info.bundled_asset = bpcAssets;
  const close = runtime.close;
  runtime.close = async () => { release(); await close(); };
  await runtime.context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/pending.png') { await pendingResource; return route.abort().catch(() => {}); }
    if (!route.request().isNavigationRequest()) return route.abort();
    if (url.pathname.includes('structure-')) {
      const kind = url.pathname.split('structure-')[1];
      const content = paragraphs.map(text => textBlock('paragraph', text));
      if (kind === 'unsupported') content[2].type = 'unknownEditorialType';
      const count = kind === 'missing' ? 5 : 6;
      const state = { props: { pageProps: { story: { body: { content } } } } };
      const mask = kind === 'masked' ? ' style="mask-image:linear-gradient(black,transparent)"' : '';
      return route.fulfill({ contentType: 'text/html', body: `<html><head><title>Structural negative fixture</title><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(state)}</script></head><body><article class="current"><h1>Structural negative fixture</h1><div class="body-content"${mask}>${paragraphs.slice(0, count).map(p => `<p data-component="paragraph">${p}</p>`).join('')}</div></article><img src="/pending.png"></body></html>` });
    }
    if (url.hostname === 'www.wsj.com') return route.fulfill({ contentType: 'text/html', body: `<html><head><meta charset="utf-8"><title>Original WSJ fixture</title></head><body><article><section>${paragraphs.map(p=>`<p data-type="paragraph">${p}</p>`).join('')}</section><p>Copyright © 2026 Dow Jones &amp; Company, Inc.</p></article></body></html>` });
    const bloomberg = url.hostname === 'www.bloomberg.com';
    const html = bloomberg
      ? `<article class="current"><h1>Delayed Bloomberg fixture</h1><div class="body-content" style="mask-image:linear-gradient(black,transparent)">${paragraphs.slice(0, 2).map(p => `<p class="ArticleBodyText_fixture">${p}</p>`).join('')}</div></article><img src="/pending.png"><script>setTimeout(()=>{const s=document.createElement('script');s.id='__NEXT_DATA__';s.type='application/json';s.textContent=${JSON.stringify(JSON.stringify(model))};document.head.append(s)},3000)</script>`
      : `<style>.regular-article-layout-module__restricted__fixture{max-height:100px;overflow:hidden;mask-image:linear-gradient(black,transparent)}</style><article><h1>Reuters paid fixture</h1><div class="regular-article-layout-module__restricted__fixture">${paragraphs.map((p, i) => `<p data-testid="paragraph-${i}">${p}</p>`).join('')}<p data-testid="paragraph-social">Follow Fixture on X.</p><div data-testid="SignOff">Editing by local fixture</div></div><div id="article-wall-fixture-paywall" data-testid="rcom-bv-wall">This is exclusive to Breakingviews subscribers</div></article>`;
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><title>Publisher fixture</title></head><body>${html}</body></html>` });
  });
  return runtime;
} });
try {
  const batch = await engine.batch({ urls: ['https://www.bloomberg.com/news/articles/2026-10-16/original-fixture', 'https://www.reuters.com/commentary/breakingviews/original-fixture-2026-10-16/', 'https://www.wsj.com/tech/original-fixture-1234abcd'], out: join(root, 'articles'), refresh: true });
  const [bloomberg, reuters, wsj] = batch.items.map(item => item.result);
  const negative = await engine.batch({ urls: ['unsupported', 'missing', 'masked'].map(kind => 'https://www.bloomberg.com/news/articles/2026-10-16/structure-' + kind), out: join(root, 'structural-negatives'), refresh: true });
  const checks = {
    intended_bpc_bundle_loaded: [...batch.browser_launches, ...negative.browser_launches].every(runtime => runtime.extension.version === runtime.bundled_asset.version && resolve(runtime.extension.source_path) === resolve(runtime.bundled_asset.runtime_path))
      && (!candidate || [...batch.browser_launches, ...negative.browser_launches].every(runtime => resolve(runtime.extension.source_path) === candidate)),
    delayed_bloomberg_body_ready: bloomberg.status === 'ok' && bloomberg.readiness.publisher_body.complete && bloomberg.metrics.paragraphs === 6,
    native_bpc_lifecycle_triggered: bloomberg.diagnostics.bpc_lifecycle?.some(action => action.invoked) === true,
    pending_resources_do_not_block_extraction: bloomberg.readiness.elapsed_ms < 15000,
    bloomberg_heading_preserved: bloomberg.content_markdown.includes('## Original fixture heading'),
    bloomberg_non_editorial_content_excluded: !/EXCLUDE_|Follow Fixture/.test(bloomberg.content_text),
    bloomberg_missing_tables_reported: bloomberg.warnings.includes('non_text_tables_not_exported'),
    reuters_local_bpc_rule_clears_wall: reuters.status === 'ok' && !reuters.readiness.visible_paywall && reuters.readiness.end_visible,
    reuters_exact_original_body: reuters.content_text === 'Reuters paid fixture ' + paragraphs.join(' '),
    wsj_original_visible_body_and_end_preserved: wsj.status === 'ok' && wsj.content_text === paragraphs.join(' ') && wsj.readiness.end_visible,
    all_original_boundaries_preserved: [bloomberg, reuters, wsj].every(result => result.readiness.first_paragraph === paragraphs[0] && result.readiness.last_paragraph === paragraphs.at(-1)),
    distinct_completion_semantics_preserved: bloomberg.diagnostics.site_evidence.completion.kind === 'publisher_body_structure' && reuters.diagnostics.site_evidence.completion.kind === 'publisher_end_marker',
    unknown_bloomberg_block_is_not_complete: negative.items[0].result.status === 'partial' && negative.items[0].result.readiness.publisher_body.unsupported_types.includes('unknownEditorialType'),
    missing_bloomberg_block_is_not_complete: negative.items[1].result.status === 'partial' && !negative.items[1].result.readiness.publisher_body.complete,
    masked_bloomberg_body_is_not_complete: negative.items[2].result.status === 'partial' && negative.items[2].result.readiness.publisher_body.obscured,
    structural_negatives_are_withheld_from_models: negative.items.every(item => !articleForModel(item.result).summarizable && !('content_markdown' in articleForModel(item.result))),
  };
  await writeJson(join(root, 'verification.json'), { status: Object.values(checks).every(Boolean) ? 'passed' : 'failed', checks, bpc: candidateReceipt || await inspectBpcAssets(batch.browser_launches[0].extension.source_path), artifacts: batch.artifact_dir });
  for (const [label, passed] of Object.entries(checks)) { console.log((passed ? 'PASS: ' : 'FAIL: ') + label); }
  assert(Object.values(checks).every(Boolean), 'Publisher smoke failed: ' + root);
  console.log('Publisher smoke passed:', root);
} finally {
  releaseResource();
  if (!profile.startsWith(profileRoot + sep)) throw new Error('Cleanup escaped project cache');
  await rm(profile, { recursive: true, force: true });
}
