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
 * jobDedupeKeys — ALL stable identities of a posting. The same job from two
 * different sources gets different guids, so a single key cannot collapse it;
 * we match on ANY of: explicit job id, apply URL (tracking params stripped), or
 * the company|title|location content key (Adli's cross-repost insight). The
 * content key is only used when company AND title are present (else too loose).
 */
function jobDedupeKeys(job) {
  const keys = [];
  if (job.guid) keys.push('guid:' + String(job.guid).toLowerCase());
  if (job.detailsPageUrl) keys.push('url:' + String(job.detailsPageUrl).split(/[?#]/)[0].toLowerCase());
  const company = normalizeForMatch(job.companyName);
  const title = normalizeForMatch(job.title);
  if (company && title) {
    const loc = normalizeForMatch(job.jobLocation?.displayName || '');
    keys.push('ctl:' + company + '|' + title + '|' + loc);
    keys.push('ct:' + company + '|' + title); // location-agnostic fallback (catches same job posted Remote + "United States", or duplicate postings)
  }
  return keys;
}

/**
 * dedupeJobs — collapse duplicates from multiple sources.
 * First occurrence wins; later sources are recorded in `alsoSeenIn` so the UI
 * can show "LinkedIn + Indeed" provenance without double-counting. A later job
 * is merged into the canonical one if ANY of its keys already maps to it.
 */
function dedupeJobs(jobs) {
  const keyToCanonical = new Map(); // any key -> canonical job object
  const out = [];
  for (const job of jobs || []) {
    const keys = jobDedupeKeys(job);
    let canonical = null;
    for (const k of keys) { if (keyToCanonical.has(k)) { canonical = keyToCanonical.get(k); break; } }
    if (canonical) {
      if (job.source && job.source !== canonical.source && !canonical.alsoSeenIn.includes(job.source)) {
        canonical.alsoSeenIn.push(job.source);
      }
      // register any of this job's keys not yet seen so a third variant also collapses
      for (const k of keys) if (!keyToCanonical.has(k)) keyToCanonical.set(k, canonical);
    } else {
      canonical = { ...job, alsoSeenIn: job.alsoSeenIn ? [...job.alsoSeenIn] : [] };
      out.push(canonical);
      for (const k of keys) keyToCanonical.set(k, canonical);
    }
  }
  return out;
}

module.exports = {
  getAppliedJobKeys,
  getDismissedJobKeys,
  jobDedupeKeys,
  dedupeJobs,
};
