/**
 * jsearch.test.js — JSearch normalizer + orchestration (injected fetch) + cross-source dedup.
 * Run: node --test test/jsearch.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeJSearchJob, normalizePublisher, formatSalary, buildQueries, searchJSearch,
} = require('../src/sources/jsearch');
const { dedupeJobs } = require('../src/lib/jobs');

// A realistic JSearch /search job object (field names verified in research).
const rawJob = {
  job_id: 'abc123',
  job_title: 'Senior QA Engineer',
  employer_name: 'Acme Corp',
  job_publisher: 'LinkedIn',
  apply_options: [{ publisher: 'LinkedIn', apply_link: 'https://linkedin.com/jobs/view/999', is_direct: false }],
  job_employment_type: 'FULLTIME',
  job_apply_link: 'https://acme.com/apply',
  job_is_remote: true,
  job_min_salary: 140000, job_max_salary: 170000, job_salary_period: 'YEAR',
  job_posted_at_datetime_utc: '2026-06-25T12:00:00Z',
  job_posted_at_timestamp: 1782000000,
  job_city: 'Austin', job_state: 'TX', job_country: 'US',
  job_description: 'Test automation, Python, API.',
};

describe('normalizePublisher', () => {
  it('detects known boards', () => {
    assert.equal(normalizePublisher('LinkedIn'), 'LinkedIn');
    assert.equal(normalizePublisher('ZipRecruiter'), 'ZipRecruiter');
    assert.equal(normalizePublisher('Glassdoor'), 'Glassdoor');
    assert.equal(normalizePublisher('Dice'), 'Dice');
    assert.equal(normalizePublisher('Indeed'), 'Indeed');
    assert.equal(normalizePublisher('SomeAtsWeNeverHeardOf'), null);
  });
});

describe('formatSalary', () => {
  it('formats a yearly range with a plain hyphen (no en/em dash)', () => {
    const s = formatSalary({ job_min_salary: 140000, job_max_salary: 170000, job_salary_period: 'YEAR' });
    assert.equal(s, '$140k-$170k');
    assert.ok(!/[–—]/.test(s)); // brand dash canon
  });
  it('formats min-only as "+"', () => {
    assert.equal(formatSalary({ job_min_salary: 120000, job_salary_period: 'YEAR' }), '$120k+');
  });
  it('formats hourly so Adli\'s isNonSalaried can catch it', () => {
    assert.equal(formatSalary({ job_min_salary: 60, job_max_salary: 75, job_salary_period: 'HOUR' }), '$60/hr-$75/hr');
  });
  it('returns null when no salary', () => {
    assert.equal(formatSalary({}), null);
  });
});

describe('normalizeJSearchJob', () => {
  it('maps JSearch fields into Adli\'s job shape', () => {
    const j = normalizeJSearchJob(rawJob);
    assert.equal(j.guid, 'jsearch_abc123');
    assert.equal(j.title, 'Senior QA Engineer');
    assert.equal(j.companyName, 'Acme Corp');
    assert.equal(j.jobLocation.displayName, 'Austin, TX');
    assert.equal(j.isRemote, true);
    assert.deepEqual(j.workplaceTypes, ['Remote']);
    assert.equal(j.salary, '$140k-$170k');
    assert.equal(j.source, 'LinkedIn');           // publisher detected → real board badge
    assert.equal(j.detailsPageUrl, 'https://acme.com/apply');
  });
  it('returns null for a job with no id', () => {
    assert.equal(normalizeJSearchJob({ job_title: 'x' }), null);
  });
});

describe('buildQueries', () => {
  it('appends a configured location', () => {
    const qs = buildQueries({ searchTerms: ['react developer'], location: 'Denver, CO', workArrangements: ['onsite'] });
    assert.equal(qs[0].query, 'react developer in Denver, CO');
  });
  it('appends "remote" when remote-only and no location', () => {
    const qs = buildQueries({ searchTerms: ['sdet'], workArrangements: ['remote'] });
    assert.equal(qs[0].query, 'sdet remote');
    assert.equal(qs[0].remoteOnly, true);
  });
});

describe('searchJSearch (injected fetch)', () => {
  it('returns [] with no_rapidapi_key when no key is configured', async () => {
    const r = await searchJSearch({ searchTerms: ['x'] }, { fetchImpl: async () => { throw new Error('should not call'); } });
    assert.equal(r.error, 'no_rapidapi_key');
    assert.equal(r.jobs.length, 0);
  });

  it('normalizes results and dedupes within a run', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [rawJob, rawJob] }) });
    const r = await searchJSearch({ searchTerms: ['qa'], workArrangements: ['remote'] }, { key: 'K', fetchImpl });
    assert.equal(r.error, null);
    assert.equal(r.jobs.length, 1);            // same job_id deduped
    assert.equal(r.jobs[0].source, 'LinkedIn');
  });

  it('keeps going when one query errors (graceful degrade)', async () => {
    let n = 0;
    const fetchImpl = async () => { n++; if (n === 1) throw new Error('boom'); return { ok: true, json: async () => ({ data: [rawJob] }) }; };
    const r = await searchJSearch({ searchTerms: ['a', 'b'] }, { key: 'K', fetchImpl });
    assert.equal(r.jobs.length, 1);            // second query still produced a job
    assert.equal(r.error, null);
  });

  it('surfaces http_<status> on a bad response', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({}) });
    const r = await searchJSearch({ searchTerms: ['a'] }, { key: 'K', fetchImpl });
    assert.equal(r.error, 'http_429');
    assert.equal(r.jobs.length, 0);
  });
});

describe('cross-source dedup (lib/jobs.dedupeJobs)', () => {
  it('collapses the same posting from two different sources and records provenance', () => {
    // Indeed-published JSearch result (source 'Indeed') ...
    const fromJSearch = normalizeJSearchJob({ ...rawJob, job_publisher: 'Indeed', apply_options: [{ publisher: 'Indeed' }] });
    assert.equal(fromJSearch.source, 'Indeed');
    // ... and the same posting surfaced by the LinkedIn ride-along (source 'LinkedIn'), different guid + url.
    const fromLinkedIn = { guid: 'li_999', title: 'Senior QA Engineer', companyName: 'Acme Corp',
      jobLocation: { displayName: 'Austin, TX' }, source: 'LinkedIn', detailsPageUrl: '' };
    const deduped = dedupeJobs([fromJSearch, fromLinkedIn]);  // collapse via company|title|location key
    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].source, 'Indeed');               // first occurrence wins
    assert.ok(deduped[0].alsoSeenIn.includes('LinkedIn'));   // provenance recorded
  });
});
