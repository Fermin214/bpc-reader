export const domain = 'fourth.reader.test';
export const fullUrl = 'https://' + domain + '/stories/alpha';
export const previewUrl = 'https://' + domain + '/stories/preview';
export const noEndUrl = 'https://' + domain + '/stories/no-end';
export const blockedUrl = 'https://' + domain + '/stories/blocked';
export const paragraphs = Array.from({ length: 6 }, (_, index) =>
  'Fourth fixture paragraph ' + (index + 1) + '. This original article has its own editorial container and footer. Its structure intentionally differs from every production publisher. Metadata may identify the article, but it cannot supply missing body text or prove that the visible article is complete.');

export const fourthSite = {
  id: domain, domain, bpc: null, scope: 'fourth_visible_story',
  isArticleUrl(url) { return /^\/stories\/[a-z-]+\/?$/.test(url.pathname); },
  normalizeUrl(url) { url.searchParams.delete('ref'); },
  searchUrl(query) { const url = new URL('https://fourth.reader.test/find'); url.searchParams.set('query', query); return url; },
  searchReady() { return !!document.querySelector('a[data-fourth-result]'); },
  collectFacts({ common }) {
    const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    const nodes = [...document.querySelectorAll('main[data-original-story] .original-copy > p')].filter(visible);
    const complete = [...document.querySelectorAll('footer[data-original-end]')].some(visible);
    const preview = common.preview || [...document.querySelectorAll('[data-original-preview]')].some(visible);
    return { ...common, paragraphs: nodes.map(node => node.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean),
      preview, completion_ready: complete, end_visible: complete, end_signal: complete ? 'fixture_editorial_footer' : null };
  },
  exportDocument() {
    const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    const nodes = [...document.querySelectorAll('main[data-original-story] .original-copy > p')].filter(visible);
    if (!nodes.length) return null;
    const output = document.implementation.createHTMLDocument(document.title);
    const article = output.createElement('article');
    for (const node of nodes) {
      const clone = node.cloneNode(true);
      clone.querySelectorAll('[hidden],[aria-hidden="true"],script,style,button').forEach(el => el.remove());
      article.append(clone);
    }
    output.body.append(article);
    return '<!doctype html>\n' + output.documentElement.outerHTML;
  },
  completionEvidence(observation) {
    return { kind: 'fixture_editorial_footer', satisfied: observation.end_visible === true, signal: observation.end_signal };
  },
};

export function fixtureHtml(url) {
  const noEnd = url.pathname.endsWith('/no-end');
  const preview = url.pathname.endsWith('/preview');
  const metadata = { '@type': 'NewsArticle', url: url.href, datePublished: '2026-10-16T02:00:00Z',
    author: ['Original Fourth Author'], inLanguage: 'de', isAccessibleForFree: true, complete: true, articleBody: 'HIDDEN_FOURTH_METADATA_BODY' };
  return '<!doctype html><html lang="de"><head><title>Original fourth article</title><script type="application/ld+json">'
    + JSON.stringify(metadata) + '</script></head><body><nav>UNRELATED_FOURTH_NAV</nav><main data-original-story><h1>Original fourth article</h1>'
    + '<section class="original-copy">' + paragraphs.map(text => '<p>' + text + '</p>').join('')
    + '<div hidden>HIDDEN_FOURTH_DOM_BODY</div></section>'
    + (noEnd ? '' : '<footer data-original-end>END OF ORIGINAL ARTICLE</footer>')
    + (preview ? '<aside data-original-preview>Subscribe to continue reading</aside>' : '')
    + '</main></body></html>';
}

