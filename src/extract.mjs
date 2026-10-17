import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { createHash } from 'node:crypto';

const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
markdown.remove(['script', 'style', 'iframe', 'form', 'button', 'input']);

function documentMetadata(doc, url) {
  const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
  const date = value => text(value) && Number.isFinite(Date.parse(value)) ? value : null;
  const meta = name => text(doc.querySelector(`meta[property="${name}"],meta[name="${name}"]`)?.content);
  const canonical = doc.querySelector('link[rel="canonical"]')?.href || url;
  const structured = [];
  const walk = data => {
    if (Array.isArray(data)) return data.forEach(walk);
    if (!data || typeof data !== 'object') return;
    if (/Article|NewsArticle|ReportageNewsArticle|BlogPosting/.test(String(data['@type']))) structured.push(data);
    if (data['@graph']) walk(data['@graph']);
  };
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try { walk(JSON.parse(script.textContent)); } catch { /* Optional metadata may be malformed. */ }
  }
  const identity = value => {
    try { const target = new URL(value, url); return target.origin + target.pathname.replace(/\/$/, ''); }
    catch { return null; }
  };
  const targets = new Set([canonical, url].map(identity).filter(Boolean));
  const identifiers = item => [item.url, item['@id'], item.mainEntityOfPage].flat()
    .map(value => typeof value === 'string' ? value : value?.['@id'] || value?.url).filter(Boolean);
  const matched = structured.filter(item => identifiers(item).some(value => targets.has(identity(value))));
  const article = matched.length === 1 ? matched[0]
    : structured.length === 1 && !identifiers(structured[0]).length ? structured[0] : null;
  const authors = [article?.author].flat().filter(Boolean)
    .map(value => text(typeof value === 'string' ? value : value.name)).filter(Boolean);
  return { structured, metadata: { title: meta('og:title') || doc.title,
    author: meta('author') || authors.join(', ') || null,
    published_at: date(meta('article:published_time')) || date(article?.datePublished),
    canonical_url: canonical, language: text(doc.documentElement.lang) || text(article?.inLanguage) } };
}

// Read allowed fields only. Never use hidden articleBody/text as a body fallback.
export function extractMetadata(html, { url } = {}) {
  const dom = new JSDOM(html, { url });
  try {
    const { published_at, author, language } = documentMetadata(dom.window.document, url).metadata;
    return { published_at, author, language };
  } finally { dom.window.close(); }
}

// Offline DOM only: jsdom never executes the page's scripts or loads resources.
export function extract(html, { url, httpStatus = 200, expected = null } = {}) {
  const dom = new JSDOM(html, { url });
  try {
    const doc = dom.window.document;
    const originalTitle = doc.title;
    const { metadata, structured } = documentMetadata(doc, url);
    const challengeFrame = !!doc.querySelector('iframe[src*="captcha-delivery.com"],script[src*="captcha-delivery.com"]');
    doc.querySelectorAll('script,style,noscript,template,[hidden],[aria-hidden="true"]').forEach(el => el.remove());
    const pageText = normalize(doc.body?.textContent);
    const challenge = /we.ve detected unusual activity|verify (that )?you are human|please (enable|turn on) (js|javascript) and (disable|enable)|checking your browser|press and hold.{0,70}(human|robot)|access to this page has been denied/i.test(pageText)
      || /just a moment|access denied|bloomberg\s*-\s*are you a robot/i.test(originalTitle)
      || (challengeFrame && pageText.length < 1000);
    const paywall = /subscribe to (continue reading|read (the )?(full|rest))|already a subscriber\?\s*(sign|log) in|unlock (this|the full) article|subscription required to (read|continue)/i.test(pageText)
      || !!doc.querySelector('[data-testid="paywall"],.snippet-promotion,#cx-paywall');
    const parsed = new Readability(doc.cloneNode(true), { charThreshold: 100 }).parse();
    const clean = new JSDOM(parsed?.content || '<body></body>', { url });
    const cleanDoc = clean.window.document;
    cleanDoc.querySelectorAll('script,style,iframe,form,input,button').forEach(el => el.remove());
    // Resolve relative links, discard executable link schemes before conversion.
    cleanDoc.querySelectorAll('[href],[src]').forEach(el => {
      for (const attr of ['href', 'src']) {
        if (!el.hasAttribute(attr)) continue;
        try {
          const target = new URL(el.getAttribute(attr), url);
          if (['http:', 'https:', 'mailto:'].includes(target.protocol)) el.setAttribute(attr, target.href);
          else el.removeAttribute(attr);
        } catch { el.removeAttribute(attr); }
      }
    });
    const textTree = cleanDoc.body.cloneNode(true);
    textTree.querySelectorAll('p,li,div,blockquote,pre,h1,h2,h3,h4,h5,h6').forEach(el => el.append('\n'));
    const text = normalize(textTree.textContent);
    const paragraphs = [...cleanDoc.querySelectorAll('p')].map(p => normalize(p.textContent)).filter(Boolean);
    const contentMarkdown = markdown.turndown(cleanDoc.body.innerHTML).trim();
    clean.window.close();
    const reasons = [];
    let status = 'unverified';
    if (challenge || [401, 403, 429].includes(httpStatus)) {
      status = 'blocked'; reasons.push(challenge ? 'browser_challenge' : `http_${httpStatus}`);
    } else if (httpStatus >= 400) {
      status = 'error'; reasons.push(`http_${httpStatus}`);
    } else if (paywall || (text.length > 0 && (text.length < 600 || paragraphs.length < 3))) {
      status = 'partial'; reasons.push(paywall ? 'paywall_signal' : 'short_body');
    } else if (!parsed || !text) {
      status = 'error'; reasons.push('no_article');
    }
    const warnings = [];
    if (structured.some(item => [false, 'false'].includes(item.isAccessibleForFree))) warnings.push('publisher_marks_paid_content');
    let validation = null;
    if (expected) {
      validation = {
        start: !!expected.start && text.startsWith(normalize(expected.start)),
        end: !!expected.end && text.endsWith(normalize(expected.end)),
        minParagraphs: paragraphs.length >= (expected.minParagraphs || 3),
        forbiddenAbsent: (expected.forbidden || []).every(value => !text.includes(value)),
      };
      if (status === 'unverified' && Object.values(validation).every(Boolean)) status = 'ok';
      else if (status === 'unverified') { status = 'partial'; reasons.push('reference_mismatch'); }
    }
    if (status === 'unverified') warnings.push('full_text_not_verified');
    const rejected = ['blocked', 'error'].includes(status);
    return {
      ...metadata, title: parsed?.title || metadata.title,
      author: parsed?.byline || metadata.author,
      language: parsed?.lang || metadata.language || null,
      status, reasons, warnings, validation,
      completeness: status === 'ok' ? 'reference_checked' : 'unknown',
      metrics: { text_chars: rejected ? 0 : text.length, paragraphs: rejected ? 0 : paragraphs.length, candidate_chars: text.length },
      content_sha256: rejected ? null : createHash('sha256').update(contentMarkdown).digest('hex'),
      content_markdown: rejected ? '' : contentMarkdown,
      content_text: rejected ? '' : text,
    };
  } finally { dom.window.close(); }
}
