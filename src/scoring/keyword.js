/**
 * keyword.js — Fast, deterministic keyword scoring.
 *
 * Ported from Adli Waziri's cowork-job-scout (test/utils.js). Used as the instant
 * score while an AI model runs, and as the fallback when the model fails or times out.
 * Word boundaries are respected so `java` does not penalize `javascript`.
 *
 * Skills weighting: pass skillsItems (from settings) to boost jobs that match skills
 * the candidate is confident in. Confidence 4–5 → up to +2 total boost.
 */

/**
 * Map confidence (1-5) to a score weight (0-2).
 * Exported so dashboard and tests can use the same formula.
 */
function skillConfidenceWeight(confidence) {
  return confidence >= 4 ? 2 : confidence >= 3 ? 1 : 0;
}

/**
 * Return true if any significant word-part of skillName appears in text
 * with word-boundary matching. Handles "Python/pytest", "BDD/Behave", etc.
 */
function skillMatchesText(skillName, text) {
  const parts = skillName.toLowerCase().split(/[\/,\s\-]+/).filter(p => p.length > 2);
  return parts.some(p =>
    new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(text)
  );
}

/**
 * Returns { score, reason } — score 1-10, reason is a short plain-English string
 * describing the dominant signals rather than a generic "keyword match".
 *
 * @param {object} job
 * @param {string[]} [penaltyTerms]
 * @param {Array<{name,years,confidence}>} [skillsItems]
 */
function keywordScoreWithReason(job, penaltyTerms, skillsItems) {
  const terms = penaltyTerms || [];
  const t = [job.title, job.summary, job.companyName].filter(Boolean).join(' ').toLowerCase();
  let s = 3;
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

  // Skills boost: confident skills (confidence ≥ 4) that appear in the job text
  // add +1 each, capped at +2 total. If the job text mentions "X+ years" of a skill
  // and the candidate's years fall short, that skill does not contribute a boost.
  const skills = Array.isArray(skillsItems) ? skillsItems : [];
  let skillBoost = 0;
  const skillHits = [];
  for (const sk of skills) {
    if (!sk.name || sk.confidence < 4) continue;
    if (!skillMatchesText(sk.name, t)) continue;
    // Check if job specifies a years requirement that the candidate doesn't meet.
    const skParts = sk.name.toLowerCase().split(/[\/,\s\-]+/).filter(p => p.length > 2);
    const yrsPattern = skParts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const yrsRe = new RegExp('(\\d+)\\+?\\s*(?:years?|yrs?)[^.]*(?:' + yrsPattern + ')', 'i');
    const yrsMatch = t.match(yrsRe);
    if (yrsMatch && parseInt(yrsMatch[1]) > (sk.years || 0)) continue;
    if (skillBoost < 2) {
      skillBoost++;
      skillHits.push(sk.name);
    }
  }
  if (skillBoost) { s = Math.min(10, s + skillBoost); hits.push(`skills match (${skillHits.join(', ')})`); }

  s = Math.min(10, s);
  let reason;
  if (hits.length && penalties.length) reason = `${hits.join(', ')} — penalised for ${penalties.join(', ')}`;
  else if (hits.length) reason = hits.join(', ');
  else if (penalties.length) reason = `penalised: ${penalties.join(', ')}`;
  else reason = 'partial keyword match';

  return { score: s, reason };
}

/** Convenience wrapper returning score only (keeps old call-sites working). */
function keywordScore(job, penaltyTerms, skillsItems) {
  return keywordScoreWithReason(job, penaltyTerms, skillsItems).score;
}

module.exports = { keywordScore, keywordScoreWithReason, skillConfidenceWeight, skillMatchesText };
