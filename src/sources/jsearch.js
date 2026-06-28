/**
 * jsearch.js — Cross-board job feed via JSearch (RapidAPI / OpenWeb Ninja).
 *
 * This is the always-on baseline source. JSearch aggregates Google-for-Jobs, so a
 * single integration covers Indeed, ZipRecruiter, Glassdoor and the LinkedIn-overlap
 * (which, per Adli, is "most jobs on LinkedIn"). It REPLACES Adli's three Cowork MCP
 * connectors, which can no longer exist standalone: Dice never published an API and
 * ZipRecruiter killed its ZipSearch API on 2025-03-31.
 *
 * Each Boat member supplies their OWN free RapidAPI key (200 req/mo, no card) so there
 * is no shared quota or single point of failure. Zero npm deps — Node's global fetch.
 * Degrades to [] on any failure (Adli's try/catch posture) so one bad board never breaks a run.
 */

const HOST = 'jsearch.p.rapidapi.com';
const BASE = `https://${HOST}/search-v2`;

/** Map a JSearch publisher string to one of Adli's known source badges. */
function normalizePublisher(s) {
  const p = String(s || '').toLowerCase();
  if (/linkedin/.test(p))                 return 'LinkedIn';
  if (/ziprecruiter|zip recruiter/.test(p)) return 'ZipRecruiter';
  if (/glassdoor/.test(p))                return 'Glassdoor';
  if (/\bdice\b/.test(p))                 return 'Dice';
  if (/indeed/.test(p))                   return 'Indeed';
  return null;
}

/** Pick the most specific known board among job_publisher + apply_options[].publisher. */
function pickSource(raw) {
  const candidates = [raw.job_publisher, ...((raw.apply_options || []).map(o => o && o.publisher))];
  for (const c of candidates) { const m = normalizePublisher(c); if (m) return m; }
  return 'JSearch';
}

/** Format JSearch's flat salary fields into Adli's salary string (plain hyphen — no en/em dash, per brand canon). */
function formatSalary(raw) {
  const lo = raw.job_min_salary, hi = raw.job_max_salary;
  const period = String(raw.job_salary_period || '').toUpperCase();
  if (lo == null && hi == null) return null;
  const hourly = period === 'HOUR';
  const fmt = (n) => hourly ? `$${Math.round(n)}/hr` : `$${Math.round(n / 1000)}k`;
  if (lo != null && hi != null && lo !== hi) return `${fmt(lo)}-${fmt(hi)}`;
  const one = lo != null ? lo : hi;
  return hourly ? fmt(one) : `${fmt(one)}+`;
}

/** PURE: normalize one JSearch job object into Adli's in-memory job shape.
 *  @param {object} raw        — raw JSearch job object
 *  @param {boolean} [forceRemote] — true when the query ran with remote_jobs_only=true
 */
function normalizeJSearchJob(raw, { forceRemote = false } = {}) {
  if (!raw || !raw.job_id) return null;
  const locText = String(raw.job_location || '').toLowerCase();
  const titleText = String(raw.job_title || '').toLowerCase();
  const descText = String(raw.job_description || '').slice(0, 500).toLowerCase();

  // Detect hybrid explicitly — JSearch's job_is_remote is unreliable for hybrid roles.
  // A job that says "hybrid" in title/location/opening description is NOT fully remote,
  // so forceRemote should not override that signal.
  const isHybrid = /\bhybrid\b/.test(locText) || /\bhybrid\b/.test(titleText) || /\bhybrid\b/.test(descText);
  const isRemote = !isHybrid && !!(raw.job_is_remote || forceRemote || /remote|anywhere/i.test(locText));

  const cityState = [raw.job_city, raw.job_state].filter(Boolean).join(', ');
  const loc = cityState || (isRemote ? 'Remote' : isHybrid ? (raw.job_country || '') : (raw.job_country || ''));

  return {
    guid: 'jsearch_' + raw.job_id,
    title: raw.job_title || '',
    companyName: raw.employer_name || '',
    jobLocation: { displayName: loc },
    postedDate: raw.job_posted_at_datetime_utc || (raw.job_posted_at_timestamp
      ? new Date(raw.job_posted_at_timestamp * 1000).toISOString() : null),
    salary: formatSalary(raw),
    employmentType: raw.job_employment_type || (raw.job_employment_types || [])[0] || '',
    detailsPageUrl: raw.job_apply_link || (raw.apply_options || [])[0]?.apply_link || '',
    workplaceTypes: isRemote ? ['Remote'] : isHybrid ? ['Hybrid'] : ['On-Site'],
    isRemote,
    source: pickSource(raw),
    summary: raw.job_description || '',
  };
}

/**
 * Build the JSearch queries from settings.
 *
 * When remote is enabled alongside other arrangements, we run two query sets:
 *   1. Location-based queries (for local/hybrid/on-site discovery)
 *   2. Remote-only queries (remote_jobs_only=true, no location in query)
 *
 * To keep request count manageable on the free tier (200/mo), remote queries are
 * deduplicated to the first REMOTE_TERM_LIMIT distinct terms only.
 */
const REMOTE_TERM_LIMIT = 5;

function buildQueries(settings) {
  const terms = (settings.searchTerms && settings.searchTerms.length)
    ? settings.searchTerms
    : ['software engineer'];
  const arr = settings.workArrangements || ['remote'];
  const wantsRemote  = arr.includes('remote');
  const wantsLocal   = arr.includes('hybrid') || arr.includes('onsite');
  const loc = (settings.location || '').trim();

  const queries = [];

  // Local queries: append location when set (finds nearby hybrid + on-site roles)
  if (wantsLocal || !wantsRemote) {
    for (const t of terms) {
      queries.push({ query: loc ? `${t} in ${loc}` : t, remoteOnly: false });
    }
  }

  // Remote queries: no location, remote_jobs_only flag (capped to avoid quota burn)
  if (wantsRemote) {
    for (const t of terms.slice(0, REMOTE_TERM_LIMIT)) {
      queries.push({ query: t, remoteOnly: true });
    }
  }

  return queries;
}

/**
 * Run JSearch for the configured searches.
 * @param {object} settings
 * @param {object} opts
 * @param {string} opts.key          — RapidAPI key (else env RAPIDAPI_KEY)
 * @param {number} [opts.numPages]   — pages per query (1-20; default 1)
 * @param {string} [opts.datePosted] — all|today|3days|week|month (default 'week')
 * @param {Function} [opts.fetchImpl]— injectable for tests
 * @param {(msg:string)=>void} [opts.onStatus]
 * @returns {Promise<{jobs:object[], error:string|null}>}
 */
async function searchJSearch(settings, opts = {}) {
  const key = opts.key || (settings && settings.rapidApiKey) || process.env.RAPIDAPI_KEY;
  const doFetch = opts.fetchImpl || fetch;
  if (!key) return { jobs: [], error: 'no_rapidapi_key' };

  const numPages = Math.min(Math.max(opts.numPages || 1, 1), 20);
  const datePosted = opts.datePosted || 'week';
  const empTypes = settingsToEmploymentTypes(settings);
  const queries = buildQueries(settings);
  const out = [];
  const seen = new Set();
  let error = null;

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    if (opts.onStatus) opts.onStatus(`JSearch: "${q.query}" (${i + 1}/${queries.length})`);
    const params = new URLSearchParams({
      query: q.query,
      country: (settings.country || 'us'), date_posted: datePosted,
    });
    if (q.remoteOnly) params.set('remote_jobs_only', 'true');
    if (empTypes) params.set('employment_types', empTypes);
    try {
      const res = await doFetch(`${BASE}?${params.toString()}`, {
        headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': HOST },
      });
      if (!res.ok) { error = res.status === 404 ? 'endpoint_not_found — check your JSearch subscription is active on rapidapi.com' : res.status === 429 ? 'rate_limited — quota exceeded for this month' : `http_${res.status}`; continue; }
      const data = await res.json();
      const jobs = Array.isArray(data.data) ? data.data : (data.data && data.data.jobs) || [];
      for (const raw of jobs) {
        const job = normalizeJSearchJob(raw, { forceRemote: q.remoteOnly });
        if (job && !seen.has(job.guid)) { seen.add(job.guid); out.push(job); }
      }
    } catch (e) { error = String(e && e.message || e); /* keep going: one query failing != run failing */ }
  }
  return { jobs: out, error: out.length ? null : error };
}

function settingsToEmploymentTypes(settings) {
  // Adli's filters drop non-salaried/contract jobs downstream; bias the fetch toward full-time.
  const arr = settings.employmentTypes;
  if (Array.isArray(arr) && arr.length) return arr.join(',');
  return 'FULLTIME';
}

module.exports = {
  searchJSearch,
  normalizeJSearchJob,
  normalizePublisher,
  pickSource,
  formatSalary,
  buildQueries,
};
