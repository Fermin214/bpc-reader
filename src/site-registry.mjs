import wsj from './sites/wsj.mjs';
import reuters from './sites/reuters.mjs';
import bloomberg from './sites/bloomberg.mjs';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

// Explicit source-level composition only. No discovery, code loading or global mutation.
export function createSiteRegistry(definitions) {
  if (!Array.isArray(definitions) || !definitions.length) throw new Error('Supply static site definitions');
  const ids = new Set(), domains = new Set();
  const sites = definitions.map(definition => {
    if (!definition.id || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(definition.domain)
      || ids.has(definition.id) || domains.has(definition.domain) || typeof definition.isArticleUrl !== 'function') throw new Error('Invalid or duplicate site definition');
    ids.add(definition.id); domains.add(definition.domain);
    return freeze({ ...definition });
  });
  return Object.freeze({
    sites: Object.freeze(sites),
    domains: Object.freeze(sites.map(site => site.domain)),
    bpcDomains: Object.freeze(sites.filter(site => site.bpc).map(site => site.bpc.domain)),
    find(value) {
      try {
        const url = value instanceof URL ? value : new URL(value);
        return sites.find(site => url.hostname === site.domain || url.hostname.endsWith('.' + site.domain)) || null;
      } catch { return null; }
    },
  });
}

export const defaultSiteRegistry = createSiteRegistry([wsj, reuters, bloomberg]);

