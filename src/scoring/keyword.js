/**
 * keyword.js — Fast, deterministic keyword scoring.
 *
 * Ported VERBATIM from Adli Waziri's cowork-job-scout (test/utils.js). Used as
 * the instant score while the AI model runs, and as the fallback when the model
 * fails or times out. Word boundaries are respected so `java` does not penalize
 * `javascript`.
 */

function keywordScore(job, penaltyTerms) {
  const terms = penaltyTerms || [];
  const t = [job.title, job.summary, job.companyName].filter(Boolean).join(' ').toLowerCase();
  let s = 4;
  if (/senior|staff|lead|principal/.test(t)) s++;
  if (/quality engineer|qa engineer|\bqe\b|sdet|test engineer|software developer in test/.test(t)) s += 2;
  if (/automation|pytest|python|api test/.test(t)) s++;
  if (/remote/.test(t) || job.isRemote) s++;
  if (/clearance|secret|top secret|dod|military|defense|homeland/.test(t)) s = Math.max(1, s - 2);
  if (/junior|associate|entry.level/.test(t)) s = Math.max(1, s - 2);
  if (terms.length) {
    const penaltyRe = new RegExp(
      terms.map(term => (/^\w/.test(term) ? '\\b' : '') + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/\w$/.test(term) ? '\\b' : '')).join('|')
    );
    if (penaltyRe.test(t)) s = Math.max(1, s - 1);
  }
  return Math.min(10, s);
}

module.exports = { keywordScore };
