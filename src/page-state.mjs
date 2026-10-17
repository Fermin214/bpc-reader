// Self-contained browser function. Only plain facts cross the page boundary.
export function collectCommonPageFacts() {
  const visible = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = el => (el?.innerText || '').replace(/\s+/g, ' ').trim();
  const bodyText = text(document.body);
  const roots = [...document.querySelectorAll('article, main, [role="main"]')].filter(visible).sort((a, b) => text(b).length - text(a).length);
  const paragraphs = [...(roots[0]?.querySelectorAll('p') || [])].filter(visible).map(text).filter(value => value.length > 30);
  const preview = [...document.querySelectorAll('.snippet-promotion,[data-testid="paywall"],#cx-paywall,#cx-snippet-overlay-container,[id^="article-wall-"][id*="paywall"]')].some(visible);
  const challenge = /we.ve detected unusual activity|verify (that )?you are human|验证设备|访问暂时受限|checking your browser|access to this page has been denied|please (enable|turn on) (js|javascript) and (disable|enable)/i.test(bodyText)
    || /just a moment|access denied|bloomberg\s*-\s*are you a robot/i.test(document.title)
    || (bodyText.length < 1000 && [...document.querySelectorAll('iframe[src*="captcha-delivery.com"]')].some(visible));
  return { title: document.title, url: location.href, protocol: location.protocol, body_text: bodyText, paragraphs, preview, challenge,
    completion_ready: true, end_visible: true, end_signal: 'publisher_end_marker' };
}

// Node-only classification preserves the original precedence and thresholds.
export function observePage(facts) {
  const paragraphs = facts.paragraphs;
  const chars = paragraphs.reduce((sum, value) => sum + value.length, 0);
  let state = 'loading';
  if (facts.preview) state = 'partial_preview';
  else if (facts.challenge && chars < 600) state = 'challenge';
  else if (chars >= 600 && paragraphs.length >= 3 && facts.completion_ready) state = 'article_ready';
  else if (facts.protocol === 'chrome-error:') state = 'navigation_error';
  return { state, title: facts.title, url: facts.url, body_chars: chars, paragraphs: paragraphs.length, visible_paywall: facts.preview,
    end_visible: facts.end_visible, end_signal: facts.end_signal,
    ...('publisher_body' in facts ? { publisher_body: facts.publisher_body } : {}),
    first_paragraph: paragraphs[0] || '', last_paragraph: paragraphs.at(-1) || '' };
}
