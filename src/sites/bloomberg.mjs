import { JSDOM, VirtualConsole } from 'jsdom';

export default {
  searchReady() { return [...document.querySelectorAll('a[href]')].some(node => /\d{4}-\d{2}-\d{2}|\/features\/\d{4}-|-[a-f\d]{8,}\/?$/i.test(node.href)); },
  id: 'bloomberg.com', domain: 'bloomberg.com', bpc: { domain: 'bloomberg.com' },
  feeds: [
    { id: 'bloomberg-technology', title: 'Bloomberg Technology', url: 'https://feeds.bloomberg.com/technology/news.rss', redirect_hosts: ['www.bloomberg.com'] },
    { id: 'bloomberg-markets', title: 'Bloomberg Markets', url: 'https://feeds.bloomberg.com/markets/news.rss', redirect_hosts: ['www.bloomberg.com'] },
    { id: 'bloomberg-businessweek', title: 'Bloomberg Businessweek', url: 'https://feeds.bloomberg.com/businessweek/news.rss', redirect_hosts: ['www.bloomberg.com'], note: 'Intermittent TLS failures observed; availability is checked per request.' },
    { id: 'bloomberg-industries', title: 'Bloomberg Industries', url: 'https://feeds.bloomberg.com/industries/news.rss', redirect_hosts: ['www.bloomberg.com'], note: 'May redirect to the publisher; intermittent TLS failures observed.' },
    { id: 'bloomberg-jason-schreier', title: 'Bloomberg — Jason Schreier', url: 'https://www.bloomberg.com/authors/AUvqMRVAZCw/jason-schreier.rss', kind: 'author' },
  ],
  normalizeUrl(url) { for (const key of ['itm_source', 'itm_campaign', 'itm_content']) url.searchParams.delete(key); },
  isArticleUrl(url) { return /\/(?:news\/(?:articles|features|newsletters)|opinion\/articles)\/\d{4}-\d{2}-\d{2}\//.test(url.pathname) || /^\/features\/\d{4}-[^/]+\/?$/.test(url.pathname); },
  searchUrl(query) { const url = new URL('https://www.bloomberg.com/search'); url.searchParams.set('query', query); return url; },
  scope: 'bloomberg_visible_body_blocks', collectFacts: collectBloombergFacts, exportDocument: visibleBloombergDocument,
  inspectPublisher: inspectBloombergBody,
  validateStructure: validateBloombergStructure,
  minimumWait({ observation, publisher, settle }) { return observation.state === 'partial_preview' && publisher ? Math.max(settle, 20000) : settle; },
  shouldActivateBpc({ observation, publisher, attempts, elapsed }) {
    return !!publisher?.expected_blocks && publisher.rendered_blocks < 5 && observation.state === 'partial_preview'
      && attempts < 2 && elapsed >= 2500 + attempts * 5000;
  },
  completionEvidence(observation) {
    const body = observation.publisher_body;
    if (body?.template_id === 'feature_ds_main_v1') return { kind: 'publisher_feature_local_end', satisfied: body.complete === true,
      template_id: body.template_id, signal: observation.end_signal, canonical_matches: body.identity,
      local_end: body.local_end, unknown_editorial_blocks: body.unknown_editorial_blocks, obscured: body.obscured,
      initial_structure: body.initial_structure || null, limitation: 'local_end_cannot_prove_no_missing_middle' };
    return { kind: 'publisher_body_structure', satisfied: body?.complete === true, signal: observation.end_signal,
      expected_blocks: body?.expected_blocks, rendered_blocks: body?.rendered_blocks, unsupported_types: body?.unsupported_types,
      missing_editorial_blocks: body?.missing_editorial_blocks, obscured: body?.obscured };
  },
};

export function collectBloombergFacts({ common, publisher }) {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => (el?.innerText || '').replace(/\s+/g, ' ').trim();
  if (publisher?.template_id === 'feature_ds_main_v1') {
    const main = document.querySelector('main.ds--main');
    const paragraphs = [...(main?.querySelectorAll(':scope > p.ds--paragraph,:scope > blockquote.ds--pullquote') || [])].filter(visible)
      .filter(el => !el.matches('blockquote.ds--pullquote') || getComputedStyle(el).opacity !== '0').map(text).filter(Boolean);
    return { ...common, paragraphs, preview: common.preview || publisher.obscured,
      completion_ready: publisher.complete === true, end_visible: publisher.local_end === true,
      end_signal: publisher.complete ? 'feature_local_editor_credit_after_body' : null, publisher_body: publisher };
  }
  const article = document.querySelector('article.current') || document.querySelector('article');
  const body = article?.querySelector('.body-content');
  const wrappers = [...(body?.children || [])].filter(node => node.matches('p[data-component="paragraph"]'));
  const nodes = (publisher?.complete
    ? publisher.editorial_indices.filter(index => publisher.roles[index] !== 'heading').map(index => wrappers[index])
    : [...(body?.querySelectorAll('p') || [])]).filter(visible).filter(node => !/^Read\s+More\s*:/i.test(text(node)) && !node.querySelector('figure,figcaption,img,video,audio,iframe'));
  const preview = common.preview || (publisher ? publisher.obscured : [...document.querySelectorAll('[class*="articleBlur"]')].some(visible));
  const complete = !!publisher?.complete;
  return { ...common, paragraphs: nodes.length ? nodes.map(text).filter(Boolean) : common.paragraphs, preview,
    completion_ready: complete, end_visible: complete, end_signal: complete ? 'publisher_body_blocks_rendered_and_unmasked' : null, publisher_body: publisher || null };
}

export function visibleBloombergDocument(model) {
  if (!/(^|\.)bloomberg\.com$/.test(location.hostname)) return null;
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const feature = model?.template_id === 'feature_ds_main_v1';
  if (feature && !model.complete) return null;
  const current = feature ? document.querySelector('main.ds--main') : document.querySelector('article.current') || document.querySelector('article');
  const body = current?.querySelector('.body-content');
  const wrappers = [...(body?.children || [])].filter(node => node.matches('p[data-component="paragraph"]'));
  const aligned = model?.complete && wrappers.length === model.expected_blocks;
  const nodes = (feature ? [...(current?.querySelectorAll(':scope > p.ds--paragraph,:scope > blockquote.ds--pullquote,:scope > h2.ds--sub-head,:scope > h3.ds--sub-head') || [])]
    : aligned ? model.editorial_indices.map(index => wrappers[index]) : [...(body?.querySelectorAll('p,h2,h3') || [])])
    .filter(visible).filter(node => (!feature || getComputedStyle(node).opacity !== '0') && !/^Read\s+More\s*:/i.test(node.innerText.trim())
      && (feature || !node.querySelector('figure,figcaption,img,video,audio,iframe')));
  if (!nodes.length) return null;
  const output = document.implementation.createHTMLDocument(document.title);
  for (const meta of document.querySelectorAll('meta[name="author"],meta[property="og:title"],meta[property="article:published_time"],link[rel="canonical"]')) output.head.append(meta.cloneNode(true));
  const article = output.createElement('article');
  const heading = current.querySelector('h1');
  if (heading) article.append(heading.cloneNode(true));
  for (const node of nodes) {
    let clone = node.cloneNode(true);
    const originals = [...node.querySelectorAll('*')], copies = [...clone.querySelectorAll('*')];
    originals.forEach((el, i) => { if (!visible(el) || el.matches('svg,button,script,style')) copies[i].remove(); });
    if (feature) clone.querySelectorAll('figure,figcaption,img,video,audio,iframe').forEach(el => el.remove());
    for (const link of clone.querySelectorAll('a[href]')) {
      try { link.setAttribute('href', new URL(link.getAttribute('href'), location.href).href); } catch { link.removeAttribute('href'); }
    }
    if (aligned && model.roles[wrappers.indexOf(node)] === 'heading') { const heading = output.createElement('h2'); heading.innerHTML = clone.innerHTML; clone = heading; }
    article.append(clone);
  }
  output.body.append(article);
  return '<!doctype html>\n' + output.documentElement.outerHTML;
}

export function inspectBloombergBody() {
  if (!/(^|\.)bloomberg\.com$/.test(location.hostname)) return null;
  if (/^\/features\/\d{4}-[^/]+\/?$/.test(location.pathname)) {
    const roots = [...document.querySelectorAll('main.ds--main')], main = roots[0];
    if (roots.length !== 1) return null;
    const children = [...main.children];
    const textSelector = 'p.ds--paragraph,blockquote.ds--pullquote,h2.ds--sub-head,h3.ds--sub-head';
    const allBlocks = children.filter(el => el.matches(textSelector));
    // Display pullquotes are supplementary components, not continuous body
    // paragraphs. Never export their transparent text or mistake it for an
    // access mask on the prose. The omission is explicit in the result.
    const transparentCallouts = allBlocks.filter(el => el.matches('blockquote.ds--pullquote') && getComputedStyle(el).opacity === '0');
    const blocks = allBlocks.filter(el => !transparentCallouts.includes(el));
    const end = main.querySelector(':scope > section.ds--back-matter');
    const credit = end?.querySelector(':scope > footer.ds--article-footer .ds--editor-credit');
    const emptyChrome = el => el.matches('div.html-newsletter-tout,div.footer,div.ds--js') && !el.textContent.trim() && !el.querySelector('p.ds--paragraph');
    const media = el => el.matches('div.styled-cap,div.ds--layout-float-right,div.ds--layout-column,div.ds--layout-wide')
      && !!el.querySelector('figure.ds--figure,img,picture') && !el.querySelector('p.ds--paragraph');
    const omitted = children.filter(el => media(el) || el.matches('div.chart,div.timeline,div.ds--podcast-layout'));
    const known = el => el.matches(textSelector + ',header.ds--lede,div.ds--timestamp,div.ds--social-share,div.ds--ad,section.ds--back-matter')
      || omitted.includes(el) || emptyChrome(el);
    const unknown = children.filter(el => !known(el)).map(el => el.tagName + ':' + el.className);
    let obscured = false;
    const obscuredBlocks = [];
    const checked = new Set();
    const heading = main.querySelector(':scope > header.ds--lede h1');
    for (const el of [...blocks, ...blocks.flatMap(el => [...el.querySelectorAll('*')]), heading, end, credit, ...(credit?.querySelectorAll('*') || [])].filter(Boolean)) {
      for (let node = el; node && !checked.has(node); node = node.parentElement) {
        checked.add(node);
        const style = getComputedStyle(node);
        if (!node.getClientRects().length || node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none'
          || style.visibility === 'hidden' || style.opacity === '0' || /blur\(/.test(style.filter) || style.maskImage !== 'none'
          || style.webkitMaskImage !== 'none' || (['hidden', 'clip'].includes(style.overflowY) && node.scrollHeight > node.clientHeight + 5)) {
          obscured = true;
          if (obscuredBlocks.length < 20) obscuredBlocks.push({ tag: node.tagName, classes: node.className?.baseVal ?? node.className,
            display: style.display, visibility: style.visibility, opacity: style.opacity, filter: style.filter,
            mask: style.maskImage, overflow: style.overflowY, rects: node.getClientRects().length, text_chars: node.textContent?.trim().length || 0 });
        }
      }
    }
    let identity = false;
    try {
      const canonical = new URL(document.querySelector('link[rel="canonical"]')?.href);
      identity = canonical.protocol === 'https:' && !canonical.username && !canonical.password && !canonical.port
        && canonical.hostname.replace(/^www\./, '') === location.hostname.replace(/^www\./, '')
        && canonical.pathname.replace(/\/$/, '') === location.pathname.replace(/\/$/, '');
    } catch {}
    const tail = children.slice(children.indexOf(blocks.at(-1)) + 1);
    const localEnd = !!end && !!credit && /^Editors?$/i.test(credit.querySelector('h4')?.innerText.trim() || '')
      && !!credit.querySelector('.ds--authorname')?.innerText.trim() && main.lastElementChild === end
      && main.querySelectorAll(':scope > section.ds--back-matter').length === 1 && tail.every(el => el === end || emptyChrome(el));
    const missing = blocks.flatMap((el, index) => el.innerText.trim() ? [] : [index]);
    return { template_id: 'feature_ds_main_v1', paragraphs: blocks.filter(el => el.matches('p.ds--paragraph')).length,
      editorial_sequence: allBlocks.map(el => el.tagName), identity, local_end: localEnd, obscured, obscured_blocks: obscuredBlocks,
      unknown_editorial_blocks: unknown, missing_editorial_blocks: missing,
      omitted_visual_components: omitted.length + blocks.reduce((sum, el) => sum + el.querySelectorAll('img,video,audio,iframe').length, 0),
      omitted_transparent_callouts: transparentCallouts.length,
      complete: identity && !!heading && blocks.length >= 3 && localEnd && !obscured && !unknown.length && !missing.length };
  }
  const article = document.querySelector('article.current') || document.querySelector('article');
  const body = article?.querySelector('.body-content');
  if (!body) return null;
  let roles = [], declared = [];
  try { declared = JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent).props.pageProps.story.body.content; roles = declared.map(block => block.type); } catch {}
  const wrappers = [...body.children].filter(node => node.matches('p[data-component="paragraph"]'));
  const editorial = ['paragraph', 'heading', 'div', 'list', 'blockquote', 'pullquote', 'quote', 'byTheNumbers'];
  const nonEditorial = ['ad', 'inline-newsletter', 'inline-recirc', 'hr', 'media', 'embed', 'tabularData'];
  const unsupported = [...new Set(roles.filter(role => !editorial.includes(role) && !nonEditorial.includes(role)))];
  let obscured = false;
  for (let node = body; node && node !== article.parentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || /blur\(/.test(style.filter)
      || style.maskImage !== 'none' || style.webkitMaskImage !== 'none'
      || (['hidden', 'clip'].includes(style.overflowY) && node.scrollHeight > node.clientHeight + 5)) obscured = true;
  }
  const aligned = roles.length > 0 && wrappers.length === roles.length;
  // This only proves semantic emptiness; publisher state is never a body source.
  const blank = node => node?.type === 'text' ? typeof node.value === 'string' && !node.value.trim()
    : ['paragraph', 'link'].includes(node?.type) && Array.isArray(node.content) && node.content.every(blank);
  const semanticEmpty = aligned ? declared.flatMap((block, index) => block.type === 'paragraph' && blank(block) && !wrappers[index].innerText.trim() ? [index] : []) : [];
  const editorialIndices = aligned ? roles.flatMap((role, index) => editorial.includes(role) && !semanticEmpty.includes(index) ? [index] : []) : [];
  const missing = editorialIndices.filter(index => !(wrappers[index].innerText || '').trim());
  return { template_id: 'news_body_blocks', roles, expected_blocks: roles.length, rendered_blocks: wrappers.length, editorial_indices: editorialIndices, semantic_empty_blocks: semanticEmpty,
    unsupported_types: unsupported, missing_editorial_blocks: missing, obscured,
    complete: aligned && !unsupported.length && !missing.length && !obscured,
    non_text_tables: roles.filter(role => role === 'tabularData').length };
}

// Node-only cross-check against the initial public HTML structure. No script
// execution, hidden-state body recovery or fixed per-article paragraph counts.
export function validateBloombergStructure({ rawHtml, publisher }) {
  if (publisher?.template_id !== 'feature_ds_main_v1') return null;
  const dom = new JSDOM(rawHtml, { virtualConsole: new VirtualConsole() });
  try {
    const root = dom.window.document.querySelector('main.ds--main');
    const blocks = [...(root?.children || [])].filter(el => el.matches('p.ds--paragraph,blockquote.ds--pullquote,h2.ds--sub-head,h3.ds--sub-head'));
    const available = dom.window.document.querySelectorAll('main.ds--main').length === 1 && blocks.length >= 3
      && root.lastElementChild?.matches('section.ds--back-matter') === true;
    return { available, satisfied: available ? JSON.stringify(blocks.map(el => el.tagName)) === JSON.stringify(publisher.editorial_sequence) : null,
      initial_editorial_blocks: blocks.length, rendered_editorial_blocks: publisher.editorial_sequence.length,
      limitation: 'cannot_detect_blocks_missing_from_both_initial_and_rendered_documents' };
  } finally { dom.window.close(); }
}

