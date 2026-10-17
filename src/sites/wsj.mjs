export default {
  searchReady() { return [...document.querySelectorAll('a[href]')].some(node => /\d{4}-\d{2}-\d{2}|-[a-f\d]{8,}\/?$/i.test(node.href)); },
  id: 'wsj.com', domain: 'wsj.com', bpc: { domain: 'wsj.com' },
  feeds: [
    { id: 'wsj-technology', title: 'WSJ Technology', url: 'https://feeds.content.dowjones.io/public/rss/RSSWSJD' },
    { id: 'wsj-business', title: 'WSJ US Business', url: 'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness' },
    { id: 'wsj-world', title: 'WSJ World', url: 'https://feeds.content.dowjones.io/public/rss/RSSWorldNews' },
    { id: 'wsj-markets', title: 'WSJ Markets', url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain' },
    { id: 'wsj-opinion', title: 'WSJ Opinion', url: 'https://feeds.content.dowjones.io/public/rss/RSSOpinion' },
  ],
  normalizeUrl(url) { url.searchParams.delete('mod'); },
  isArticleUrl(url) { return /-[a-f\d]{8,}\/?$/i.test(url.pathname); },
  searchUrl(query) { const url = new URL('https://www.wsj.com/search'); url.searchParams.set('query', query); return url; },
  scope: 'wsj_visible_editorial_blocks', collectFacts: collectWsjFacts, exportDocument: visibleWsjDocument,
  completionEvidence(observation) {
    return { kind: 'publisher_end_marker', satisfied: observation.end_visible === true, signal: observation.end_signal };
  },
};

export function collectWsjFacts({ common }) {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => (el?.innerText || '').replace(/\s+/g, ' ').trim();
  const nodes = [...document.querySelectorAll('article section p[data-type="paragraph"],article section p[data-type="tagline"]')].filter(visible).filter(el => !/^Write to\s/i.test(text(el)));
  const section = [...document.querySelectorAll('article section')].find(section => section.querySelector('p[data-type="paragraph"]'));
  const copyright = [...(section?.parentElement.children || [])].some(el => el.tagName === 'P' && visible(el)
    && /^Copyright\s*©\s*\d{4}\s*Dow Jones/i.test(text(el)) && !!(section.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
  const complete = copyright || /Appeared in the .*print edition|contributed to this article/i.test(common.body_text);
  return { ...common, paragraphs: nodes.length ? nodes.map(text).filter(Boolean) : common.paragraphs,
    completion_ready: complete, end_visible: complete, end_signal: copyright ? 'article_local_copyright_after_body' : complete ? 'publisher_end_marker' : null };
}

export function visibleWsjDocument() {
  if (!/(^|\.)wsj\.com$/.test(location.hostname)) return null;
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const nodes = [...document.querySelectorAll('article section p[data-type="paragraph"],article section p[data-type="tagline"],article section h2[data-type="hed"],article section h3[data-type="hed"]')]
    .filter(visible).filter(el => !/^Write to\s/i.test(el.innerText.trim()));
  if (!nodes.length) return null;
  const output = document.implementation.createHTMLDocument(document.title);
  for (const meta of document.querySelectorAll('meta[name="author"],meta[property="og:title"],meta[property="article:published_time"],link[rel="canonical"]')) output.head.append(meta.cloneNode(true));
  const article = output.createElement('article');
  const heading = document.querySelector('h1');
  if (heading) article.append(heading.cloneNode(true));
  for (const node of nodes) {
    const clone = node.cloneNode(true);
    const originals = [...node.querySelectorAll('*')], copies = [...clone.querySelectorAll('*')];
    originals.forEach((el, i) => {
      if (!visible(el) || el.matches('svg,button,script,style,[class*="Chiclet"],[class*="ArrowHiddenLabel"]')) copies[i].remove();
    });
    for (const link of clone.querySelectorAll('a[href]')) {
      try { link.setAttribute('href', new URL(link.getAttribute('href'), location.href).href); } catch { link.removeAttribute('href'); }
    }
    article.append(clone);
  }
  output.body.append(article);
  return '<!doctype html>\n' + output.documentElement.outerHTML;
}

