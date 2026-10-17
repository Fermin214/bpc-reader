import { createHash } from 'node:crypto';
import { defaultSiteRegistry } from './site-registry.mjs';

export function getSiteAdaptations(siteRegistry = defaultSiteRegistry) {
  const localSiteRules = Object.fromEntries(siteRegistry.sites.filter(site => site.bpc?.localRule)
    .map(site => [site.bpc.ruleName, site.bpc.localRule]));
  const siteRulesReceipt = { version: 1, sha256: createHash('sha256').update(JSON.stringify(localSiteRules)).digest('hex'),
    domains: Object.values(localSiteRules).map(rule => rule.domain) };
  return { localSiteRules, siteRulesReceipt };
}

// Keep existing imports and raw-rule hashing compatible.
export const { localSiteRules, siteRulesReceipt } = getSiteAdaptations();
