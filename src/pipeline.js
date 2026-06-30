/**
 * pipeline.js — the integration layer: gather → dedupe → score → filter → store.
 *
 * Mirrors Adli's run() flow (dashboard.html): fetch from every enabled source, dedupe across
 * sources, score, then apply his display-filter chain (score<5 / dismissed / hybrid-outside-metro /
 * non-salaried / work-arrangement / defense-exclude / min-salary / already-applied). Source impls
 * are injectable so the orchestration is testable offline.
 */

const { searchJSearch } = require('./sources/jsearch');
const { searchLinkedIn } = require('./sources/linkedin');
const { searchEmail } = require('./sources/email');
const { dedupeJobs, getAppliedJobKeys, getDismissedJobKeys } = require('./lib/jobs');
const { normalizeForMatch } = require('./lib/format');
const { getEffectiveLocalAreaRe } = require('./lib/searchterms');
const { isHybridOutsideLocalArea, isNonSalaried, meetsWorkArrangement, isDefenseRole, meetsMinSalary } = require('./scoring/filters');
const { scoreJobs } = require('./scoring/ai');

/** Run every enabled source, dedupe across them, return jobs + per-source counts + the LinkedIn canary. */
async function gather(settings, opts = {}) {
  const src = settings.sources || {};
  const jsearchImpl = opts.jsearchImpl || searchJSearch;
  const linkedinImpl = opts.linkedinImpl || searchLinkedIn;
  const all = [];
  const errors = [];
  let canary = null;

  if (src.jsearch !== false) {
    const r = await jsearchImpl(settings, opts);
    all.push(...(r.jobs || []));
    if (r.error) errors.push(`jsearch:${r.error}`);
  }
  if (src.linkedinRideAlong || src.linkedinGuest !== false) {
    const r = await linkedinImpl(settings, opts);
    all.push(...(r.jobs || []));
    canary = r.canary || null;
    if (r.error) errors.push(`linkedin:${r.error}`);
  }
  if (src.appleMail || src.imap) {
    const r = await (opts.emailImpl || searchEmail)(settings, opts);
    all.push(...(r.jobs || []));
    if (r.errors && r.errors.length) errors.push(...r.errors);
  }

  const jobs = dedupeJobs(all);
  const counts = {};
  for (const j of jobs) counts[j.source] = (counts[j.source] || 0) + 1;
  return { jobs, counts, canary, errors };
}

/** Adli's render-time filter chain (pure). Highest score first. */
function applyDisplayFilters(jobs, settings, ctx = {}) {
  const localAreaRe = getEffectiveLocalAreaRe(settings);
  const appliedKeys = ctx.appliedKeys || new Set();
  const dismissedKeys = ctx.dismissedKeys || new Set();
  const dismissedGuids = ctx.dismissedGuids || new Set();
  return jobs.filter(j => {
    if ((j.matchScore ?? 0) < 5) return false;
    if (dismissedGuids.has(j.guid)) return false;
    if (isHybridOutsideLocalArea(j, localAreaRe)) return false;
    if (isNonSalaried(j)) return false;
    if (!meetsWorkArrangement(j, settings)) return false;
    if (settings.defensePreference === 'exclude' && isDefenseRole(j)) return false;
    if (!meetsMinSalary(j, settings.minSalary, settings.hideNoSalary)) return false;
    const key = normalizeForMatch(j.companyName) + '|' + normalizeForMatch(j.title);
    if (appliedKeys.has(key)) return false;
    if (dismissedKeys.has(key)) return false;
    return true;
  }).sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
}

/** Build the dismissed/applied filter context from the DB (what the dashboard's GET /api/jobs uses). */
function displayContext(db) {
  const dismissedMap = db.getDismissedMap();
  return {
    appliedKeys: getAppliedJobKeys(db.getActs()),
    dismissedKeys: getDismissedJobKeys(dismissedMap),
    dismissedGuids: new Set(Object.keys(dismissedMap)),
  };
}

/**
 * Pre-score title gate: drop jobs whose title contains none of the required terms.
 * Empty/blank setting = pass everything through (no gate).
 */
function applyTitleGate(jobs, settings) {
  const raw = settings.scoreTitleRequire || '';
  const terms = raw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
  if (!terms.length) return jobs;
  return jobs.filter(j => {
    const title = (j.title || '').toLowerCase();
    return terms.some(t => title.includes(t));
  });
}

/** One daily pass: gather → title-gate → score → upsert to DB → record the run. */
async function runDaily(db, settings, opts = {}) {
  const runId = db.startRun();
  let result;
  try {
    const { jobs, counts, canary, errors } = await gather(settings, opts);
    const gated = applyTitleGate(jobs, settings);
    const cap = opts.maxScore || settings.scoringCap || 60;
    const toScore = gated.slice(0, cap);                           // Adli caps the scored batch
    const unscoredRemainder = gated.slice(cap);                   // beyond-cap: stored with null score
    const { jobs: scored } = await scoreJobs(toScore, {
      ...opts, settings, dismissedMap: db.getDismissedMap(), provider: settings.scoreProvider,
      anthropicKey: settings.anthropicKey || process.env.ANTHROPIC_API_KEY,
    });
    for (const j of scored) db.upsertJob(j, { runId });
    for (const j of unscoredRemainder) db.upsertJobUnscored(j, { runId });
    db.finishRun(runId, {
      sourceCounts: counts, jobCount: gated.length, scoredCount: scored.length,
      status: errors.length ? 'partial' : 'ok', note: errors.join('; '),
    });
    result = { runId, counts, canary, jobCount: gated.length, totalFetched: jobs.length, scoredCount: scored.length, errors };
  } catch (e) {
    db.finishRun(runId, { status: 'error', note: String(e && e.message || e) });
    throw e;
  }
  return result;
}

module.exports = { gather, applyDisplayFilters, displayContext, runDaily };
