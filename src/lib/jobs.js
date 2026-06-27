/**
 * jobs.js — Applied / dismissed key helpers + cross-source dedup.
 *
 * The key helpers are ported VERBATIM from Adli Waziri's cowork-job-scout
 * (test/utils.js). They build a "normalizedCompany|normalizedTitle" Set so a
 * job that gets a fresh GUID on re-post is still recognized as already
 * applied-to or dismissed.
 *
 * dedupeJobs() is NEW: with three sources (JSearch + Apple Mail + Gmail) the
 * same posting routinely arrives more than once, so we collapse on a stable
 * key before scoring.
 */

const { normalizeForMatch } = require('./format');

/**
 * getAppliedJobKeys — parameterized version.
 * @param {Object} acts — the raw activities object (id -> activity)
 */
function getAppliedJobKeys(acts) {
  const keys = new Set();
  for (const a of Object.values(acts || {})) {
    if (a.type === 'Job Application' && a.employer && a.role) {
      keys.add(normalizeForMatch(a.employer) + '|' + normalizeForMatch(a.role));
    }
  }
  return keys;
}

/**
 * getDismissedJobKeys — parameterized version.
 * @param {Object} dismissedMap — { [guid]: { companyName, title, ... } }
 */
function getDismissedJobKeys(dismissedMap) {
  const keys = new Set();
  for (const entry of Object.values(dismissedMap || {})) {
    if (entry.companyName && entry.title) {
      keys.add(normalizeForMatch(entry.companyName) + '|' + normalizeForMatch(entry.title));
    }
  }
  return keys;
}

/**
 * jobDedupeKey — the stable identity of a posting across sources.
 * Prefers an explicit job id, then the apply URL, then company|title|location.
 */
function jobDedupeKey(job) {
  if (job.guid) return 'guid:' + String(job.guid).toLowerCase();
  if (job.detailsPageUrl) {
    // Strip query/fragment so tracking params don't defeat the match.
    const url = String(job.detailsPageUrl).split(/[?#]/)[0].toLowerCase();
    return 'url:' + url;
  }
  const loc = job.jobLocation?.displayName || '';
  return 'ctl:' + normalizeForMatch(job.companyName) + '|' +
    normalizeForMatch(job.title) + '|' + normalizeForMatch(loc);
}

/**
 * dedupeJobs — collapse duplicates from multiple sources.
 * First occurrence wins; later sources are recorded in `alsoSeenIn` so the UI
 * can show "LinkedIn + Indeed" provenance without double-counting.
 */
function dedupeJobs(jobs) {
  const byKey = new Map();
  for (const job of jobs || []) {
    const key = jobDedupeKey(job);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...job, alsoSeenIn: [] });
    } else if (job.source && job.source !== existing.source && !existing.alsoSeenIn.includes(job.source)) {
      existing.alsoSeenIn.push(job.source);
    }
  }
  return [...byKey.values()];
}

module.exports = {
  getAppliedJobKeys,
  getDismissedJobKeys,
  jobDedupeKey,
  dedupeJobs,
};
