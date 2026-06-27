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
const BASE = `https://${HOST}/search`;

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

/** PURE: normalize one JSearch job object into Adli's in-memory job shape. */
function normalizeJSearchJob(raw) {
  if (!raw || !raw.job_id) return null;
  const isRemote = !!raw.job_is_remote;
  const loc = [raw.job_city, raw.job_state].filter(Boolean).join(', ')
    || (isRemote ? 'Remote' : (raw.job_country || ''));
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
    workplaceTypes: isRemote ? ['Remote'] : ['On-Site'],
    isRemote,
    source: pickSource(raw),
    summary: raw.job_description || '',
  };
}

/**
 * Build the JSearch queries from settings. One query per configured search term; a
 * configured location is appended ("term in city"); remote-only when arrangement is remote.
 */
function buildQueries(settings) {
  const terms = (settings.searchTerms && settings.searchTerms.length)
    ? settings.searchTerms
    : ['software engineer']; // neutral default so a fresh install returns something
  const arr = settings.workArrangements || ['remote'];
  const remoteOnly = arr.length === 1 && arr[0] === 'remote';
  const loc = (settings.location || '').trim();
  return terms.map(t => ({
    query: loc ? `${t} in ${loc}` : (remoteOnly ? `${t} remote` : t),
    remoteOnly,
  }));
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
      query: q.query, page: '1', num_pages: String(numPages),
      country: (settings.country || 'us'), date_posted: datePosted,
    });
    if (q.remoteOnly) params.set('remote_jobs_only', 'true');
    if (empTypes) params.set('employment_types', empTypes);
    try {
      const res = await doFetch(`${BASE}?${params.toString()}`, {
        headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': HOST },
      });
      if (!res.ok) { error = `http_${res.status}`; continue; }
      const data = await res.json();
      for (const raw of (data.data || [])) {
        const job = normalizeJSearchJob(raw);
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
