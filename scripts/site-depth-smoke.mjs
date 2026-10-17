import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { launch, capture } from '../src/browser.mjs';
import { readArticle } from '../src/managed-reader.mjs';
import { discoverArticles } from '../src/discovery.mjs';
import { articleCandidate } from '../src/reader-config.mjs';
import { articleForModel } from '../src/reader-mcp.mjs';
import { writeJson } from '../src/reader-storage.mjs';

// Original fixture text, actual browser functions and managed acquisition.
const root = resolve('output/playwright/site-depth-' + Date.now()), checks = {};
const check = (name, pass) => { checks[name] = !!pass; assert(pass, name); console.log('PASS:', name); };
const url = 'https://www.bloomberg.com/features/2026-original-fixture/';
const paragraphs = Array.from({ length: 6 }, (_, i) => `Original feature paragraph ${i + 1}. This visible text tests a bounded publisher root and ordered article paragraphs. Only the local article ending and known blocks can support a complete reading result. Hidden state is never a body fallback.`);
function html(kind) {
  const end = '<section class="ds--back-matter"><footer class="ds--article-footer"><div class="ds--editor-credit"><h4>Editor</h4><span class="ds--authorname">Original Editor</span></div></footer></section>';
  const head = `<html lang="en"><head><title>Original feature fixture</title><link rel="canonical" href="${kind === 'wrong-canonical' ? url + 'wrong' : url}"></head><body>`;
  let body = `<main class="ds--main"><header class="ds--lede"><h1>Original feature fixture</h1></header>${paragraphs.map((p, i) => '<p class="ds--paragraph">' + p + '</p>' + (i === 2 ? '<div class="chart"><p>OMIT_CHART_TEXT</p></div>' : '')).join('')}${kind === 'unknown' ? '<section>Unknown editorial text</section>' : ''}${kind === 'no-end' ? '' : end}</main>`;
  if (kind === 'masked') body = body.replace('class="ds--main"', 'class="ds--main" style="filter:blur(3px)"');
  if (kind === 'hidden-end') body = body.replace('class="ds--back-matter"', 'class="ds--back-matter" hidden');
  if (kind === 'missing-middle') body += '<script>setTimeout(()=>document.querySelectorAll("p.ds--paragraph")[2].remove(),100)</script>';
  if (kind === 'transparent-callout') body = body.replace('<div class="chart">', '<blockquote class="ds--pullquote" style="opacity:0">OMIT_TRANSPARENT_DISPLAY_QUOTE</blockquote><div class="chart">');
  if (kind === 'hidden-prose') body = body.replace('<p class="ds--paragraph">','<p class="ds--paragraph" style="opacity:0">');
  if (kind === 'server-missing-middle') body = body.replace('<p class="ds--paragraph">'+paragraphs[2]+'</p>','');
  if (kind === 'inline-image') body = body.replace(paragraphs[1],paragraphs[1]+'<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">');
  if (kind === 'challenge-window') body = '<p>Verify that you are human</p><script>setTimeout(()=>{document.body.innerHTML='+JSON.stringify(body)+'},2500)</script>';
  if (kind === 'global-footer') body = body.replace(end, '') + end;
  return head + body + '</body></html>';
}
let searchKind = '403';
const runtime = await launch({ mode: 'baseline', browser: 'chromium', headed: false });
await runtime.context.route('**/*', route => {
  const u = new URL(route.request().url());
  if (u.hostname === 'www.google.com') {
    if (searchKind === 'network') return route.abort('connectionfailed');
    return route.fulfill({ status: searchKind === 'challenge' ? 200 : 403, contentType: 'text/html', body: '<html><body>not a robot: unusual traffic</body></html>' });
  }
  if (u.pathname === '/search') return route.fulfill({ status: searchKind === 'both-fail' ? 403 : 200, contentType: 'text/html', body: `<html><body><a href="${url}">Original feature publisher search article</a></body></html>` });
  if (u.pathname.includes('/news/newsletters/')) {
    const kind = u.searchParams.get('kind');
    const blocks = paragraphs.map(value => ({type:'paragraph',content:[{type:'text',value}]}));
    blocks.splice(2,0,{type:'paragraph',content:kind === 'unknown-blank' ? [{type:'unrecognized',content:[]}] : [{type:'text',value:kind === 'nonempty' ? 'Declared meaningful text' : '  '},{type:'link',content:[]}]});
    const model = {props:{pageProps:{story:{body:{content:blocks}}}}};
    const wrappers = paragraphs.map(p=>'<p data-component="paragraph">'+p+'</p>'); wrappers.splice(2,0,'<p data-component="paragraph"><span> </span></p>');
    if(kind==='unaligned') wrappers.pop();
    return route.fulfill({contentType:'text/html',body:`<html><head><title>Original newsletter fixture</title><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(model)}</script></head><body><article><h1>Original newsletter fixture</h1><div class="body-content">${wrappers.join('')}</div></article></body></html>`});
  }
  return route.fulfill({ contentType: 'text/html', body: html(u.searchParams.get('kind') || 'full') });
});
try {
  check('Feature and dated newsletter admitted; media/navigation rejected', !!articleCandidate(url) && !!articleCandidate('https://www.bloomberg.com/news/newsletters/2026-10-09/original-fixture') && !articleCandidate('https://www.bloomberg.com/news/newsletters') && !articleCandidate('https://www.wsj.com/livecoverage/original-1234abcd'));
  for (const kind of ['full', 'transparent-callout', 'inline-image', 'server-missing-middle', 'hidden-prose', 'no-end', 'hidden-end', 'masked', 'unknown', 'wrong-canonical', 'global-footer', 'missing-middle']) {
    const captured = await capture(runtime.context, url + '?kind=' + kind, { readyTimeout: 1000 });
    await writeJson(join(root, kind + '-evidence.json'), captured.siteEvidence);
    check('Feature evidence: ' + kind, captured.siteEvidence.completion.satisfied === ['full','transparent-callout','inline-image','server-missing-middle'].includes(kind));
    if(kind==='transparent-callout')check('Transparent display callouts are recorded and never exported',captured.diagnostics.readiness.publisher_body.omitted_transparent_callouts===1 && !captured.articleHtml.includes('OMIT_TRANSPARENT_DISPLAY_QUOTE'));
    if(kind==='inline-image')check('Inline media omission preserves its visible prose',captured.articleHtml.includes(paragraphs[1])&&!captured.articleHtml.includes('<img'));
    if(kind==='server-missing-middle')check('Shared initial/render loss remains an explicit evidence limit',captured.siteEvidence.completion.limitation==='local_end_cannot_prove_no_missing_middle');
    if (kind === 'missing-middle') check('Initial HTML detects a paragraph removed during rendering', captured.siteEvidence.completion.initial_structure.satisfied === false && !captured.articleHtml);
  }
  for(const kind of ['blank','nonempty','unknown-blank','unaligned']) {
    const captured=await capture(runtime.context,'https://www.bloomberg.com/news/newsletters/2026-10-09/original-fixture?kind='+kind,{readyTimeout:1000});
    check('Strict semantic blank block: '+kind,captured.siteEvidence.completion.satisfied===(kind==='blank'));
  }
  const full = await readArticle({ url, runtime, timeoutMs: 10000, out: join(root, 'full') });
  check('Managed feature exports only visible prose with limits', full.status === 'ok' && full.warnings.includes('feature_visual_components_and_captions_not_exported') && full.warnings.includes('feature_completeness_cannot_prove_no_missing_middle') && !full.content_text.includes('OMIT_CHART_TEXT'));
  const partial = await readArticle({ url: url + '?kind=unknown', runtime, timeoutMs: 10000, out: join(root, 'partial') });
  check('Unsupported feature returns partial artifacts inside budget', partial.status === 'partial' && partial.elapsed_ms < 11000 && partial.diagnostics.site_evidence.completion.satisfied === false && !articleForModel(partial).summarizable);
  const timed = await readArticle({ url, runtime, timeoutMs: 10000, out: join(root, 'timeout'), onState: () => new Promise(() => {}) });
  check('Hard deadline closes only the capture page and retains diagnostics', timed.status === 'error' && timed.reasons.includes('read_timeout') && timed.readiness && runtime.context.pages().length === 1);
  const next = await readArticle({ url, runtime, timeoutMs: 10000, out: join(root, 'next') });
  check('Next acquisition succeeds in same runtime after hard timeout', next.status === 'ok' && runtime.context.pages().length === 1);
  let notifyWaiting;
  const waiting = new Promise(done => { notifyWaiting=done; });
  const interactive = readArticle({url:url+'?kind=challenge-window',runtime,interactive:true,timeoutMs:10000,out:join(root,'interactive'),onState:observation=>{if(observation.state==='challenge')notifyWaiting();}});
  await waiting; await new Promise(done=>setTimeout(done,800));
  const interaction = JSON.parse(await readFile(join(root,'interactive/interaction-required.json'),'utf8'));
  check('Verification page stays open while its interaction marker is waiting',interaction.state==='waiting_for_site_verification'&&runtime.context.pages().length===2);
  const verified = await interactive;
  check('Verification can complete in the same page before normal cleanup',verified.status==='ok'&&runtime.context.pages().length===1&&JSON.parse(await readFile(join(root,'interactive/interaction-required.json'),'utf8')).state==='completed');
  for (const kind of ['403', 'challenge', 'network', 'both-fail']) {
    searchKind = kind;
    const result = await discoverArticles(runtime.context, { query: 'original feature', sites: ['bloomberg.com'], limit: 1 }, { out: join(root, 'discovery-' + kind) });
    check('Independent publisher fallback: ' + kind, kind === 'both-fail' ? result.status === 'error' && result.source_errors.length === 2 && !result.candidates.length : result.status === 'ok' && result.candidates[0]?.url === url && result.source_errors.length === 1);
  }
  await writeJson(join(root, 'verification.json'), { status: 'passed', checks });
  console.log('Site depth smoke passed:', root);
} finally { await runtime.close(); }
