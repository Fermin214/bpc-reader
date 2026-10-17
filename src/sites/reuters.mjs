export default {
  searchReady() { return [...document.querySelectorAll('a[href]')].some(node => /\d{4}-\d{2}-\d{2}|-[a-f\d]{8,}\/?$/i.test(node.href)); },
  id: 'reuters.com', domain: 'reuters.com',
  bpc: {
    domain: 'reuters.com', ruleName: 'Reuters',
    localRule: {
      domain: 'reuters.com', allow_cookies: 1,
      block_regex: '\\.reuters\\.com/arc/subs/p\\.min\\.js',
      cs_code: [
        { hide_elem: '[data-testid="rcom-bv-wall"]' },
        { add_style: '[class*="regular-article-layout-module__restricted"]{max-height:none!important;height:auto!important;overflow:visible!important;filter:none!important;mask-image:none!important;-webkit-mask-image:none!important}[class*="regular-article-layout-module__restricted"]::after{display:none!important}' },
      ],
    },
  },
  isArticleUrl(url) { return /\d{4}-\d{2}-\d{2}\/?$/.test(url.pathname); },
  searchUrl(query) { const url = new URL('https://www.reuters.com/site-search/'); url.searchParams.set('query', query); return url; },
  scope: 'reuters_visible_paragraphs', collectFacts: collectReutersFacts, exportDocument: visibleReutersDocument,
  minimumWait({ observation, settle }) { return Math.max(settle, observation.state === 'partial_preview' ? 15000 : 3000); },
  completionEvidence(observation) {
    return { kind: 'publisher_end_marker', satisfied: observation.end_visible === true, signal: observation.end_signal };
  },
};

export function collectReutersFacts({ common }) {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => (el?.innerText || '').replace(/\s+/g, ' ').trim();
  const nodes = [...document.querySelectorAll('article [data-testid^="paragraph-"]')].filter(visible).filter(node => !/^Follow\s.+\son\s/i.test(text(node)));
  const obscured = [...document.querySelectorAll('[class*="regular-article-layout-module__restricted"]')].some(node => {
    const style = getComputedStyle(node);
    return visible(node) && (/blur\(/.test(style.filter) || style.maskImage !== 'none'
      || (['hidden', 'clip'].includes(style.overflowY) && node.scrollHeight > node.clientHeight + 5));
  });
  const complete = [...document.querySelectorAll('[data-testid="SignOff"]')].some(visible);
  return { ...common, paragraphs: nodes.length ? nodes.map(text).filter(Boolean) : common.paragraphs,
    preview: obscured || common.preview, completion_ready: complete, end_visible: complete, end_signal: complete ? 'publisher_end_marker' : null };
}

export function visibleReutersDocument() {
  if (!/(^|\.)reuters\.com$/.test(location.hostname)) return null;
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const paragraphs = [...document.querySelectorAll('article [data-testid^="paragraph-"]')].filter(visible).filter(node => !/^Follow\s.+\son\s/i.test(node.innerText.trim()));
  if (!paragraphs.length) return null;
  const first = paragraphs[0], last = paragraphs.at(-1);
  const nodes = [...document.querySelectorAll('article [data-testid^="paragraph-"],article h2[data-testid="Heading"],article h3[data-testid="Heading"]')]
    .filter(visible).filter(el => (el === first || (first.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
      && (el === last || (el.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING)));
  const output = document.implementation.createHTMLDocument(document.title);
  for (const meta of document.querySelectorAll('meta[name="author"],meta[property="og:title"],meta[property="article:published_time"],link[rel="canonical"]')) output.head.append(meta.cloneNode(true));
  const article = output.createElement('article');
  const heading = document.querySelector('h1');
  if (heading) article.append(heading.cloneNode(true));
  for (const node of nodes) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll('svg,button,script,style,[hidden],[aria-hidden="true"],[class*="visually-hidden"],[class*="VisuallyHidden"],[class*="screen-reader"]').forEach(el => el.remove());
    const block = output.createElement(/^H[23]$/.test(node.tagName) ? node.tagName : 'p');
    block.innerHTML = clone.innerHTML;
    for (const link of block.querySelectorAll('a[href]')) {
      try { link.setAttribute('href', new URL(link.getAttribute('href'), location.href).href); } catch { link.removeAttribute('href'); }
    }
    article.append(block);
  }
  output.body.append(article);
  return '<!doctype html>\n' + output.documentElement.outerHTML;
}

