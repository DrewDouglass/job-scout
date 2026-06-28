/**
 * keyword.js — Fast, deterministic keyword scoring.
 *
 * Ported from Adli Waziri's cowork-job-scout (test/utils.js). Used as the instant
 * score while an AI model runs, and as the fallback when the model fails or times out.
 * Word boundaries are respected so `java` does not penalize `javascript`.
 */

/**
 * Returns { score, reason } — score 1-10, reason is a short plain-English string
 * describing the dominant signals rather than a generic "keyword match".
 */
function keywordScoreWithReason(job, penaltyTerms) {
  const terms = penaltyTerms || [];
  const t = [job.title, job.summary, job.companyName].filter(Boolean).join(' ').toLowerCase();
  let s = 4;
  const hits = [], penalties = [];

  if (/senior|staff|lead|principal/.test(t)) { s++; hits.push('senior-level title'); }
  if (/quality engineer|qa engineer|\bqe\b|sdet|test engineer|software developer in test/.test(t)) { s += 2; hits.push('QA/SDET role'); }
  if (/automation|pytest|python|api test/.test(t)) { s++; hits.push('automation/Python keywords'); }
  if (/remote/.test(t) || job.isRemote) { s++; hits.push('remote'); }

  if (/clearance|secret|top secret|dod|military|defense|homeland/.test(t)) {
    s = Math.max(1, s - 2); penalties.push('defense/clearance role');
  }
  if (/junior|associate|entry.level/.test(t)) {
    s = Math.max(1, s - 2); penalties.push('junior/entry-level');
  }
  if (terms.length) {
    const penaltyRe = new RegExp(
      terms.map(term => (/^\w/.test(term) ? '\\b' : '') + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/\w$/.test(term) ? '\\b' : '')).join('|')
    );
    if (penaltyRe.test(t)) { s = Math.max(1, s - 1); penalties.push('penalty term match'); }
  }

  s = Math.min(10, s);
  let reason;
  if (hits.length && penalties.length) reason = `${hits.join(', ')} — penalised for ${penalties.join(', ')}`;
  else if (hits.length) reason = hits.join(', ');
  else if (penalties.length) reason = `penalised: ${penalties.join(', ')}`;
  else reason = 'partial keyword match';

  return { score: s, reason };
}

/** Convenience wrapper returning score only (keeps old call-sites working). */
function keywordScore(job, penaltyTerms) {
  return keywordScoreWithReason(job, penaltyTerms).score;
}

module.exports = { keywordScore, keywordScoreWithReason };
