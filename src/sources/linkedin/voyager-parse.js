/**
 * voyager-parse.js — PURE parser for captured LinkedIn Voyager job-card responses.
 *
 * The CDP ride-along (observer.js) navigates a dedicated logged-in Chrome to the user's
 * own saved job-search URLs and captures whatever the page fetches. This module turns the
 * captured `voyagerJobsDashJobCards` JSON (LinkedIn's normalized+json shape) into Adli's
 * job shape.
 *
 * LONGEVITY RULE (canon, project_shani_linkedin_ridealong_answer_2026_06_18): match the
 * captured response by URL substring elsewhere; HERE, parse `included[]` by `$type`. NEVER
 * hardcode the GraphQL queryId or the decorationId version — those rotate ~weekly; the
 * entity `$type` strings are far stabler. If LinkedIn renames the $type, the loud canary fires.
 */

const JOBPOSTING_TYPE_RE = /\.JobPosting$/;              // the entity itself (not JobPostingCard, etc.)
const COMPANY_TYPE_RE = /\.(Company|Organization)$/;
const COMPANY_URN_RE = /urn:li:(?:fsd_company|company|fsd_organization):\d+/i;
const JOB_URN_ID_RE = /:(\d+)$/;
const WORKPLACE_URN_DIGIT_RE = /:(\d+)$/;               // urn:li:fsd_workplaceType:1|2|3

function jobIdFromUrn(urn) {
  const m = String(urn || '').match(JOB_URN_ID_RE);
  return m ? m[1] : null;
}

/** urn:li:fsd_workplaceType:1=On-site, 2=Remote, 3=Hybrid (LinkedIn's standard mapping). */
function workplaceFromUrns(urns) {
  const out = [];
  let remote = false;
  for (const u of (urns || [])) {
    const m = String(u || '').match(WORKPLACE_URN_DIGIT_RE);
    const d = m ? m[1] : '';
    if (d === '2') { out.push('Remote'); remote = true; }
    else if (d === '3') out.push('Hybrid');
    else if (d === '1') out.push('On-site');
  }
  return { workplaceTypes: out.length ? out : ['On-site'], isRemote: remote };
}

/** Best-effort company-name resolution across the variable normalized+json nesting. */
function resolveCompanyName(jp, byUrn) {
  // 1. direct/inline fields seen across deploys
  const direct = jp.companyName
    || jp.companyDetails?.companyResolutionResult?.name
    || jp.companyDetails?.company?.name;
  if (direct) return direct;
  // 2. follow any company urn referenced anywhere on the JobPosting to a Company entity
  const blob = JSON.stringify(jp);
  const m = blob.match(COMPANY_URN_RE);
  if (m) {
    const ent = byUrn.get(m[0]);
    if (ent && ent.name) return ent.name;
  }
  return '';
}

/** Normalize one JobPosting entity into Adli's job shape. */
function normalizeVoyagerJob(jp, byUrn, id) {
  const { workplaceTypes, isRemote } = workplaceFromUrns(jp.workplaceTypes || jp['*workplaceTypes']);
  const listedAt = jp.listedAt || jp.originalListedAt || jp.createdAt;
  return {
    guid: 'linkedin_' + id,
    title: jp.title || '',
    companyName: resolveCompanyName(jp, byUrn),
    jobLocation: { displayName: jp.formattedLocation || jp.location || '' },
    postedDate: listedAt ? new Date(Number(listedAt)).toISOString() : null,
    salary: jp.salaryInsights?.compensationBreakdown || null, // usually absent on the card
    employmentType: jp.employmentStatus?.name || jp.employmentType || '',
    detailsPageUrl: `https://www.linkedin.com/jobs/view/${id}`,
    workplaceTypes,
    isRemote,
    source: 'LinkedIn',
    summary: jp.jobDescription?.text || jp.description?.text || '',
  };
}

/**
 * Parse one or more captured Voyager responses → normalized jobs (deduped by job id).
 * @param {object|object[]} captured — parsed normalized+json response object(s)
 */
function parseVoyagerJobCards(captured) {
  const responses = Array.isArray(captured) ? captured : [captured];
  const included = [];
  for (const r of responses) if (r && Array.isArray(r.included)) included.push(...r.included);
  const byUrn = new Map();
  for (const e of included) if (e && e.entityUrn) byUrn.set(e.entityUrn, e);

  const jobs = [];
  const seen = new Set();
  for (const e of included) {
    if (!e || !JOBPOSTING_TYPE_RE.test(e['$type'] || '')) continue;
    const id = jobIdFromUrn(e.entityUrn);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    jobs.push(normalizeVoyagerJob(e, byUrn, id));
  }
  return jobs;
}

module.exports = {
  parseVoyagerJobCards,
  normalizeVoyagerJob,
  jobIdFromUrn,
  workplaceFromUrns,
  resolveCompanyName,
};
