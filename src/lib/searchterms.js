/**
 * searchterms.js — Effective search-term + local-area expansion from settings.
 *
 * Ported VERBATIM from Adli Waziri's cowork-job-scout (test/utils.js). The
 * Dice/Indeed/ZR variants are kept intact so his test suite stays green; in the
 * re-platformed tool the generic `searchTerms` list drives the JSearch query
 * and the per-board "extra" lists remain available for power users.
 */

/**
 * getEffectiveDiceSearches — parameterized version.
 * @param {Object} settings
 * @param {string[]} fallback — default searches if no searchTerms configured
 */
function getEffectiveDiceSearches(settings, fallback = []) {
  const base = settings.searchTerms && settings.searchTerms.length
    ? settings.searchTerms.map(t => t + ' remote')
    : fallback;
  const extra = settings.diceSearchTerms && settings.diceSearchTerms.length
    ? settings.diceSearchTerms
    : [];
  return [...new Set([...base, ...extra])];
}

/**
 * getEffectiveIndeedSearches — parameterized version.
 * @param {Object} settings
 * @param {Array<{q,loc}>} fallback
 */
function getEffectiveIndeedSearches(settings, fallback = []) {
  const base = settings.searchTerms && settings.searchTerms.length
    ? settings.searchTerms.map(t => ({ q: t, loc: 'remote' }))
    : fallback;
  const extra = settings.indeedSearchTerms && settings.indeedSearchTerms.length
    ? settings.indeedSearchTerms.map(line => {
        const [q, loc] = line.split('|').map(x => x.trim());
        return { q: q || line.trim(), loc: loc || 'remote' };
      })
    : [];
  const seen = new Set(base.map(x => x.q));
  return [...base, ...extra.filter(x => !seen.has(x.q))];
}

/**
 * getEffectiveZrSearches — parameterized version.
 * @param {Object} settings
 * @param {string[]} fallback
 */
function getEffectiveZrSearches(settings, fallback = []) {
  const base = settings.searchTerms && settings.searchTerms.length
    ? settings.searchTerms
    : fallback;
  const extra = settings.zrSearchTerms && settings.zrSearchTerms.length
    ? settings.zrSearchTerms
    : [];
  return [...new Set([...base, ...extra])];
}

/**
 * getEffectiveLocalAreaRe — parameterized version.
 * @param {Object} settings
 * @param {RegExp} fallback
 */
function getEffectiveLocalAreaRe(settings, fallback = /remote/i) {
  if (!settings.localMetroCities || !settings.localMetroCities.length) return fallback;
  const cities = ['remote', ...settings.localMetroCities]
    .map(c => c.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b(' + cities.join('|') + ')\\b', 'i');
}

module.exports = {
  getEffectiveDiceSearches,
  getEffectiveIndeedSearches,
  getEffectiveZrSearches,
  getEffectiveLocalAreaRe,
};
