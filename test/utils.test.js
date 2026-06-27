/**
 * utils.test.js — Tests for dashboard.html utility functions.
 *
 * Uses Node's built-in test runner (Node 18+). No install required.
 * Run with: npm test  (from the github/ directory)
 *          or: node --test test/utils.test.js
 *
 * These tests cover the logic most likely to regress on changes:
 *   - Job filtering (salary, arrangement, defense, contract)
 *   - Keyword scoring
 *   - Applied/dismissed job key normalization
 *   - Search term generation
 *   - Indeed result parsing
 *   - Display utilities
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeForMatch,
  esc,
  scoreClass,
  sourceBadgeClass,
  typeInfo,
  formatDate,
  getWeekBounds,
  isDefenseRole,
  getJobArrangement,
  meetsWorkArrangement,
  meetsMinSalary,
  isNonSalaried,
  isHybridOutsideLocalArea,
  keywordScore,
  getAppliedJobKeys,
  getDismissedJobKeys,
  getEffectiveDiceSearches,
  getEffectiveIndeedSearches,
  getEffectiveZrSearches,
  getEffectiveLocalAreaRe,
  parseIndeedResults,
} = require('./utils');

// ─── normalizeForMatch ────────────────────────────────────────────────────────

describe('normalizeForMatch', () => {
  it('lowercases and strips non-alphanumeric', () => {
    assert.equal(normalizeForMatch('Acme Corp.'), 'acmecorp');
  });
  it('handles spaces, commas, hyphens', () => {
    assert.equal(normalizeForMatch('Senior QA Engineer, Inc.'), 'seniorqaengineerinc');
  });
  it('handles null/undefined gracefully', () => {
    assert.equal(normalizeForMatch(null), '');
    assert.equal(normalizeForMatch(undefined), '');
    assert.equal(normalizeForMatch(''), '');
  });
  it('punctuation differences produce the same key', () => {
    assert.equal(normalizeForMatch('Acme Corp.'), normalizeForMatch('Acme Corp'));
  });
});

// ─── getAppliedJobKeys ────────────────────────────────────────────────────────

describe('getAppliedJobKeys', () => {
  it('returns empty set for empty activities', () => {
    assert.equal(getAppliedJobKeys({}).size, 0);
  });

  it('includes Job Application entries with employer and role', () => {
    const acts = {
      a1: { type: 'Job Application', employer: 'Acme Corp', role: 'Senior QA Engineer' },
    };
    const keys = getAppliedJobKeys(acts);
    assert.ok(keys.has('acmecorp|seniorqaengineer'));
  });

  it('ignores non-application activity types', () => {
    const acts = {
      a1: { type: 'Networking', employer: 'Acme Corp', role: 'Senior QA Engineer' },
      a2: { type: 'Interview', employer: 'Beta Inc', role: 'QA Lead' },
    };
    assert.equal(getAppliedJobKeys(acts).size, 0);
  });

  it('ignores entries missing employer or role', () => {
    const acts = {
      a1: { type: 'Job Application', employer: 'Acme Corp' },       // no role
      a2: { type: 'Job Application', role: 'Senior QA Engineer' },  // no employer
    };
    assert.equal(getAppliedJobKeys(acts).size, 0);
  });

  it('normalizes punctuation so re-posted jobs still match', () => {
    const acts = {
      a1: { type: 'Job Application', employer: 'Acme, Corp.', role: 'Senior QA Engineer' },
    };
    assert.ok(getAppliedJobKeys(acts).has('acmecorp|seniorqaengineer'));
  });

  it('handles multiple applications', () => {
    const acts = {
      a1: { type: 'Job Application', employer: 'Acme Corp', role: 'Senior QA Engineer' },
      a2: { type: 'Job Application', employer: 'Beta Inc', role: 'Staff QE' },
      a3: { type: 'Interview', employer: 'Gamma Ltd', role: 'QA Lead' },
    };
    const keys = getAppliedJobKeys(acts);
    assert.equal(keys.size, 2);
    assert.ok(keys.has('betainc|staffqe'));
  });
});

// ─── getDismissedJobKeys ──────────────────────────────────────────────────────

describe('getDismissedJobKeys', () => {
  it('returns empty set for empty map', () => {
    assert.equal(getDismissedJobKeys({}).size, 0);
  });

  it('produces normalized key from companyName and title', () => {
    const map = {
      guid1: { companyName: 'Acme Corp', title: 'Senior QA Engineer', reason: 'bad fit' },
    };
    assert.ok(getDismissedJobKeys(map).has('acmecorp|seniorqaengineer'));
  });

  it('ignores entries missing companyName or title', () => {
    const map = {
      g1: { companyName: 'Acme Corp' },
      g2: { title: 'Senior QA Engineer' },
    };
    assert.equal(getDismissedJobKeys(map).size, 0);
  });
});

// ─── isDefenseRole ────────────────────────────────────────────────────────────

describe('isDefenseRole', () => {
  it('detects clearance requirement in summary', () => {
    assert.ok(isDefenseRole({ title: 'Software Engineer', summary: 'Secret clearance required', companyName: 'SAIC' }));
  });
  it('detects DoD in title', () => {
    assert.ok(isDefenseRole({ title: 'Senior QA Engineer - DoD', summary: '', companyName: 'Leidos' }));
  });
  it('detects "defense contractor" in company name', () => {
    assert.ok(isDefenseRole({ title: 'Test Engineer', summary: '', companyName: 'Defense Contractor Inc' }));
  });
  it('detects Top Secret in summary', () => {
    assert.ok(isDefenseRole({ title: 'QA Lead', summary: 'Must have Top Secret clearance', companyName: 'General Dynamics' }));
  });
  it('detects military in summary', () => {
    assert.ok(isDefenseRole({ title: 'Senior Engineer', summary: 'Support military programs', companyName: 'Raytheon' }));
  });
  it('detects homeland security in summary', () => {
    assert.ok(isDefenseRole({ title: 'QA Engineer', summary: 'Homeland security experience', companyName: 'Perspecta' }));
  });
  it('does not flag a normal QA role', () => {
    assert.equal(isDefenseRole({ title: 'Senior QA Engineer', summary: 'SaaS platform', companyName: 'JumpCloud' }), false);
  });
  it('handles missing fields without throwing', () => {
    assert.equal(isDefenseRole({}), false);
  });
});

// ─── getJobArrangement ────────────────────────────────────────────────────────

describe('getJobArrangement', () => {
  it('isRemote flag → remote', () => {
    assert.equal(getJobArrangement({ isRemote: true, workplaceTypes: [] }), 'remote');
  });
  it('workplaceTypes includes Remote → remote', () => {
    assert.equal(getJobArrangement({ isRemote: false, workplaceTypes: ['Remote'] }), 'remote');
  });
  it('workplaceTypes includes Hybrid → hybrid', () => {
    assert.equal(getJobArrangement({ isRemote: false, workplaceTypes: ['Hybrid'] }), 'hybrid');
  });
  it('On-Site → onsite', () => {
    assert.equal(getJobArrangement({ isRemote: false, workplaceTypes: ['On-Site'] }), 'onsite');
  });
  it('missing workplaceTypes → onsite', () => {
    assert.equal(getJobArrangement({ isRemote: false }), 'onsite');
  });
});

// ─── meetsWorkArrangement ─────────────────────────────────────────────────────

describe('meetsWorkArrangement', () => {
  const remoteJob = { isRemote: true, workplaceTypes: ['Remote'] };
  const hybridJob = { isRemote: false, workplaceTypes: ['Hybrid'] };
  const onsiteJob = { isRemote: false, workplaceTypes: ['On-Site'] };

  it('remote-only setting accepts remote, rejects hybrid and onsite', () => {
    const cfg = { workArrangements: ['remote'] };
    assert.ok(meetsWorkArrangement(remoteJob, cfg));
    assert.equal(meetsWorkArrangement(hybridJob, cfg), false);
    assert.equal(meetsWorkArrangement(onsiteJob, cfg), false);
  });

  it('remote+hybrid setting accepts both, rejects onsite', () => {
    const cfg = { workArrangements: ['remote', 'hybrid'] };
    assert.ok(meetsWorkArrangement(remoteJob, cfg));
    assert.ok(meetsWorkArrangement(hybridJob, cfg));
    assert.equal(meetsWorkArrangement(onsiteJob, cfg), false);
  });

  it('empty workArrangements accepts everything', () => {
    assert.ok(meetsWorkArrangement(onsiteJob, { workArrangements: [] }));
  });
});

// ─── meetsMinSalary ───────────────────────────────────────────────────────────

describe('meetsMinSalary', () => {
  it('no salary + hideNoSalary=true → excluded', () => {
    assert.equal(meetsMinSalary({ salary: '' }, 100000, true), false);
  });
  it('no salary + hideNoSalary=false → included', () => {
    assert.ok(meetsMinSalary({ salary: '' }, 100000, false));
  });
  it('salary above minimum → included', () => {
    assert.ok(meetsMinSalary({ salary: '$130,000 - $150,000' }, 120000, false));
  });
  it('salary below minimum → excluded', () => {
    assert.equal(meetsMinSalary({ salary: '$80,000 - $100,000' }, 120000, false), false);
  });
  it('no minimum set (0) → always included', () => {
    assert.ok(meetsMinSalary({ salary: '$50,000' }, 0, false));
  });
  it('k-shorthand: 130k meets 120k minimum', () => {
    assert.ok(meetsMinSalary({ salary: '130k' }, 120000, false));
  });
  it('k-shorthand: 100k does not meet 120k minimum', () => {
    assert.equal(meetsMinSalary({ salary: '100k' }, 120000, false), false);
  });
  it('range uses the higher number: $90k–$110k meets $100k minimum', () => {
    assert.ok(meetsMinSalary({ salary: '$90k–$110k' }, 100000, false));
  });
  it('range uses the higher number: $90k–$110k does not meet $120k minimum', () => {
    assert.equal(meetsMinSalary({ salary: '$90k–$110k' }, 120000, false), false);
  });
});

// ─── isNonSalaried ────────────────────────────────────────────────────────────

describe('isNonSalaried', () => {
  it('hourly /hr rate → non-salaried', () => {
    assert.ok(isNonSalaried({ salary: '$45/hr', employmentType: '', summary: '' }));
  });
  it('"per hour" in salary → non-salaried', () => {
    assert.ok(isNonSalaried({ salary: '$45 per hour', employmentType: '', summary: '' }));
  });
  it('Contract employment type → non-salaried', () => {
    assert.ok(isNonSalaried({ salary: '', employmentType: 'Contract', summary: '' }));
  });
  it('Temporary employment type → non-salaried', () => {
    assert.ok(isNonSalaried({ salary: '', employmentType: 'Temporary', summary: '' }));
  });
  it('C2C in summary → non-salaried', () => {
    assert.ok(isNonSalaried({ salary: '', employmentType: '', summary: 'This is a C2C opportunity' }));
  });
  it('1099 in summary → non-salaried', () => {
    assert.ok(isNonSalaried({ salary: '', employmentType: '', summary: 'W-2 contract position' }));
  });
  it('contract-to-hire in summary → non-salaried', () => {
    assert.ok(isNonSalaried({ salary: '', employmentType: '', summary: 'contract-to-hire role' }));
  });
  it('normal full-time salaried role → not flagged', () => {
    assert.equal(isNonSalaried({ salary: '$120,000', employmentType: 'FULLTIME', summary: 'Great benefits' }), false);
  });
  it('handles missing fields without throwing', () => {
    assert.equal(isNonSalaried({}), false);
  });
});

// ─── isHybridOutsideLocalArea ─────────────────────────────────────────────────

describe('isHybridOutsideLocalArea', () => {
  const localAreaRe = /\b(remote|boulder|denver|broomfield|westminster)\b/i;

  it('remote job is never filtered', () => {
    assert.equal(isHybridOutsideLocalArea(
      { isRemote: true, workplaceTypes: [], jobLocation: { displayName: 'New York, NY' } },
      localAreaRe
    ), false);
  });
  it('hybrid job in local area → not filtered', () => {
    assert.equal(isHybridOutsideLocalArea(
      { isRemote: false, workplaceTypes: ['Hybrid'], jobLocation: { displayName: 'Denver, CO' } },
      localAreaRe
    ), false);
  });
  it('hybrid job outside local area → filtered', () => {
    assert.ok(isHybridOutsideLocalArea(
      { isRemote: false, workplaceTypes: ['Hybrid'], jobLocation: { displayName: 'New York, NY' } },
      localAreaRe
    ));
  });
  it('on-site job outside local area → filtered', () => {
    assert.ok(isHybridOutsideLocalArea(
      { isRemote: false, workplaceTypes: ['On-Site'], jobLocation: { displayName: 'Austin, TX' } },
      localAreaRe
    ));
  });
  it('Remote in workplaceTypes bypasses filter even if isRemote=false', () => {
    assert.equal(isHybridOutsideLocalArea(
      { isRemote: false, workplaceTypes: ['Remote'], jobLocation: { displayName: 'Austin, TX' } },
      localAreaRe
    ), false);
  });
});

// ─── keywordScore ─────────────────────────────────────────────────────────────

describe('keywordScore', () => {
  it('senior remote QA automation role scores high (>=8)', () => {
    const job = { title: 'Senior QA Engineer - Remote', summary: 'Python automation, pytest, api test', companyName: 'Acme', isRemote: true };
    assert.ok(keywordScore(job) >= 8);
  });

  it('defense/clearance role scores lower than identical clean role', () => {
    const clean   = { title: 'Senior QA Engineer', summary: '', companyName: 'Acme', isRemote: true };
    const defense = { title: 'Senior QA Engineer', summary: 'Secret clearance required', companyName: 'SAIC', isRemote: true };
    assert.ok(keywordScore(defense) < keywordScore(clean));
  });

  it('junior role scores lower than senior equivalent', () => {
    const senior = { title: 'Senior QA Engineer', summary: '', companyName: 'Acme', isRemote: true };
    const junior = { title: 'Junior QA Engineer', summary: '', companyName: 'Acme', isRemote: true };
    assert.ok(keywordScore(junior) < keywordScore(senior));
  });

  it('score never exceeds 10', () => {
    const job = { title: 'Senior Staff QA Engineer SDET pytest automation Python remote', summary: 'api test automation python pytest', companyName: 'Acme', isRemote: true };
    assert.ok(keywordScore(job) <= 10);
  });

  it('score never falls below 1 even with heavy penalties', () => {
    const job = { title: 'Junior QA Engineer', summary: 'Secret clearance military defense', companyName: 'SAIC', isRemote: false };
    assert.ok(keywordScore(job) >= 1);
  });

  it('non-QA role without bonuses scores at most 6', () => {
    const job = { title: 'Software Engineer', summary: '', companyName: 'Acme', isRemote: false };
    assert.ok(keywordScore(job) <= 6);
  });

  it('penalty terms param: penalised job scores lower than same job without terms', () => {
    const job = { title: 'Senior SDET', summary: 'playwright selenium automation required', companyName: 'Acme', isRemote: true };
    assert.ok(keywordScore(job, ['playwright', 'selenium']) < keywordScore(job, []));
  });

  it('penalty terms param: java term matches "java" but not "javascript"', () => {
    const javaJob   = { title: 'Senior QA', summary: 'java selenium backend', companyName: 'Acme', isRemote: true };
    const jsJob     = { title: 'Senior QA', summary: 'javascript frontend automation', companyName: 'Acme', isRemote: true };
    const withPenalty   = keywordScore(javaJob, ['java']);
    const withoutPenalty = keywordScore(javaJob, []);
    assert.ok(withPenalty < withoutPenalty, 'java term should penalise the java job');
    // "javascript" contains "java" as substring but \b prevents match
    assert.equal(keywordScore(jsJob, ['java']), keywordScore(jsJob, []), 'java term should not penalise javascript job');
  });

  it('penalty terms: score stays >= 1 with multiple stacked penalties', () => {
    const job = { title: 'Junior QA', summary: 'java selenium appium playwright clearance', companyName: 'X', isRemote: false };
    assert.ok(keywordScore(job, ['java', 'selenium', 'appium', 'playwright']) >= 1);
  });

  it('no penalty terms passed: no penalty applied (default behaviour for fresh installs)', () => {
    const job = { title: 'Senior QA', summary: 'playwright selenium java automation', companyName: 'Acme', isRemote: true };
    assert.equal(keywordScore(job), keywordScore(job, []));
  });
});

// ─── scoreClass ───────────────────────────────────────────────────────────────

describe('scoreClass', () => {
  it('9 and 10 → s9', () => { assert.equal(scoreClass(9), 's9'); assert.equal(scoreClass(10), 's9'); });
  it('8 → s8', () => { assert.equal(scoreClass(8), 's8'); });
  it('7 → s7', () => { assert.equal(scoreClass(7), 's7'); });
  it('6 → s6', () => { assert.equal(scoreClass(6), 's6'); });
  it('5 and below → s5', () => { assert.equal(scoreClass(5), 's5'); assert.equal(scoreClass(1), 's5'); });
});

// ─── sourceBadgeClass ─────────────────────────────────────────────────────────

describe('sourceBadgeClass', () => {
  const cases = [
    ['Dice', 'b-dice'], ['Indeed', 'b-indeed'], ['ZipRecruiter', 'b-ziprecruiter'],
    ['LinkedIn', 'b-linkedin'], ['Glassdoor', 'b-glassdoor'], ['JSearch', 'b-jsearch'],
    ['Unknown', 'b-other'], [null, 'b-other'], [undefined, 'b-other'],
  ];
  for (const [src, expected] of cases) {
    it(`source "${src}" → ${expected}`, () => assert.equal(sourceBadgeClass(src), expected));
  }
});

// ─── typeInfo ─────────────────────────────────────────────────────────────────

describe('typeInfo', () => {
  it('isRemote=true → Remote', () => {
    assert.deepEqual(typeInfo([], true), { label: 'Remote', cls: 't-remote' });
  });
  it('types includes remote → Remote', () => {
    assert.deepEqual(typeInfo(['Remote'], false), { label: 'Remote', cls: 't-remote' });
  });
  it('types includes hybrid → Hybrid', () => {
    assert.deepEqual(typeInfo(['Hybrid'], false), { label: 'Hybrid', cls: 't-hybrid' });
  });
  it('no remote or hybrid → On-Site', () => {
    assert.deepEqual(typeInfo(['On-Site'], false), { label: 'On-Site', cls: 't-onsite' });
  });
});

// ─── esc ──────────────────────────────────────────────────────────────────────

describe('esc', () => {
  it('escapes < > & "', () => {
    assert.equal(esc('<b>Tom & "Jerry"</b>'), '&lt;b&gt;Tom &amp; &quot;Jerry&quot;&lt;/b&gt;');
  });
  it('handles null/undefined', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
  });
  it('leaves normal strings unchanged', () => {
    assert.equal(esc('Hello world'), 'Hello world');
  });
});

// ─── formatDate ───────────────────────────────────────────────────────────────

describe('formatDate', () => {
  const now = new Date('2025-06-15T12:00:00Z').getTime();

  it('returns — for falsy input', () => {
    assert.equal(formatDate('', now), '—');
    assert.equal(formatDate(null, now), '—');
  });
  it('same day → Today', () => {
    assert.equal(formatDate('2025-06-15', now), 'Today');
  });
  it('1 day ago → 1d ago', () => {
    assert.equal(formatDate('2025-06-14', now), '1d ago');
  });
  it('7 days ago → 7d ago', () => {
    assert.equal(formatDate('2025-06-08', now), '7d ago');
  });
});

// ─── getWeekBounds ────────────────────────────────────────────────────────────

describe('getWeekBounds', () => {
  // Wednesday June 11 2025
  const wednesday = new Date('2025-06-11T10:00:00');

  it('offset 0: week runs Sun June 8 → Sat June 14', () => {
    const { start, end } = getWeekBounds(0, wednesday);
    assert.equal(start.getDay(), 0);   // Sunday
    assert.equal(end.getDay(), 6);     // Saturday
    assert.equal(start.getDate(), 8);
    assert.equal(end.getDate(), 14);
  });
  it('offset -1: previous week starts June 1', () => {
    const { start } = getWeekBounds(-1, wednesday);
    assert.equal(start.getDate(), 1);
  });
  it('offset +1: next week starts June 15', () => {
    const { start } = getWeekBounds(1, wednesday);
    assert.equal(start.getDate(), 15);
  });
});

// ─── getEffectiveDiceSearches ─────────────────────────────────────────────────

describe('getEffectiveDiceSearches', () => {
  const fallback = ['senior qa engineer remote', 'sdet remote'];

  it('uses fallback when no searchTerms configured', () => {
    assert.deepEqual(getEffectiveDiceSearches({ searchTerms: [] }, fallback), fallback);
  });
  it('appends "remote" to each searchTerm', () => {
    const result = getEffectiveDiceSearches({ searchTerms: ['senior qa engineer', 'staff qe'] }, fallback);
    assert.ok(result.includes('senior qa engineer remote'));
    assert.ok(result.includes('staff qe remote'));
  });
  it('merges extra diceSearchTerms', () => {
    const result = getEffectiveDiceSearches({
      searchTerms: ['senior qa engineer'],
      diceSearchTerms: ['automation engineer python'],
    }, fallback);
    assert.ok(result.includes('senior qa engineer remote'));
    assert.ok(result.includes('automation engineer python'));
  });
  it('deduplicates identical terms', () => {
    const result = getEffectiveDiceSearches({
      searchTerms: ['senior qa engineer'],
      diceSearchTerms: ['senior qa engineer remote'],
    }, fallback);
    assert.equal(result.filter(t => t === 'senior qa engineer remote').length, 1);
  });
});

// ─── getEffectiveIndeedSearches ───────────────────────────────────────────────

describe('getEffectiveIndeedSearches', () => {
  const fallback = [{ q: 'senior qa engineer', loc: 'remote' }];

  it('uses fallback when no searchTerms', () => {
    assert.deepEqual(getEffectiveIndeedSearches({ searchTerms: [] }, fallback), fallback);
  });
  it('maps searchTerms to {q, loc:"remote"} objects', () => {
    const result = getEffectiveIndeedSearches({ searchTerms: ['senior qa engineer'] }, fallback);
    assert.deepEqual(result[0], { q: 'senior qa engineer', loc: 'remote' });
  });
  it('parses pipe-separated q|loc in indeedSearchTerms', () => {
    const result = getEffectiveIndeedSearches({
      searchTerms: ['senior qa engineer'],
      indeedSearchTerms: ['staff engineer|denver co'],
    }, fallback);
    assert.ok(result.some(x => x.q === 'staff engineer' && x.loc === 'denver co'));
  });
  it('deduplicates by q — base takes priority over extra', () => {
    const result = getEffectiveIndeedSearches({
      searchTerms: ['senior qa engineer'],
      indeedSearchTerms: ['senior qa engineer|austin tx'],
    }, fallback);
    const matches = result.filter(x => x.q === 'senior qa engineer');
    assert.equal(matches.length, 1);
    assert.equal(matches[0].loc, 'remote'); // base wins
  });
});

// ─── getEffectiveZrSearches ───────────────────────────────────────────────────

describe('getEffectiveZrSearches', () => {
  const fallback = ['software engineer', 'senior developer'];

  it('uses fallback when no searchTerms', () => {
    assert.deepEqual(getEffectiveZrSearches({ searchTerms: [] }, fallback), fallback);
  });
  it('uses searchTerms directly — no "remote" suffix added', () => {
    const result = getEffectiveZrSearches({ searchTerms: ['senior qa engineer'] }, fallback);
    assert.ok(result.includes('senior qa engineer'));
    assert.equal(result.includes('senior qa engineer remote'), false);
  });
  it('merges extra zrSearchTerms', () => {
    const result = getEffectiveZrSearches({
      searchTerms: ['senior qa engineer'],
      zrSearchTerms: ['automation engineer'],
    }, fallback);
    assert.ok(result.includes('automation engineer'));
  });
});

// ─── getEffectiveLocalAreaRe ──────────────────────────────────────────────────

describe('getEffectiveLocalAreaRe', () => {
  const fallback = /remote/i;

  it('returns fallback when no localMetroCities configured', () => {
    assert.equal(getEffectiveLocalAreaRe({ localMetroCities: [] }, fallback), fallback);
  });
  it('always matches "remote" regardless of configured cities', () => {
    const re = getEffectiveLocalAreaRe({ localMetroCities: ['Boulder', 'Denver'] }, fallback);
    assert.ok(re.test('Remote, US'));
  });
  it('matches configured cities', () => {
    const re = getEffectiveLocalAreaRe({ localMetroCities: ['Boulder', 'Denver'] }, fallback);
    assert.ok(re.test('Boulder, CO'));
    assert.ok(re.test('Denver, CO'));
    assert.equal(re.test('Austin, TX'), false);
  });
  it('handles city names with special regex characters without throwing', () => {
    assert.doesNotThrow(() =>
      getEffectiveLocalAreaRe({ localMetroCities: ['St. Louis', 'Kansas City (MO)'] }, fallback)
    );
  });
});

// ─── parseIndeedResults ───────────────────────────────────────────────────────

describe('parseIndeedResults', () => {
  it('returns empty array for empty/falsy input', () => {
    assert.deepEqual(parseIndeedResults(''), []);
    assert.deepEqual(parseIndeedResults(null), []);
  });

  const sampleBlock = `**Job Title:** Senior QA Engineer
**Company:** Acme Corp
**Location:** Remote
**Job Id:** abc123
**Posted on:** 2025-06-01
**Compensation:** $120,000 - $140,000
**Job Type:** Full-time
**View Job URL:** https://indeed.com/job/abc123`;

  it('parses a single job block correctly', () => {
    const jobs = parseIndeedResults(sampleBlock);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, 'Senior QA Engineer');
    assert.equal(jobs[0].companyName, 'Acme Corp');
    assert.equal(jobs[0].guid, 'indeed_abc123');
    assert.equal(jobs[0].isRemote, true);
    assert.equal(jobs[0].salary, '$120,000 - $140,000');
    assert.equal(jobs[0].source, 'Indeed');
  });

  it('strips (Remote) prefix from title', () => {
    const block = sampleBlock.replace('**Job Title:** Senior QA Engineer', '**Job Title:** (Remote) Senior QA Engineer');
    assert.equal(parseIndeedResults(block)[0].title, 'Senior QA Engineer');
  });

  it('sets isRemote=false and workplaceTypes=[On-Site] for non-remote location', () => {
    const block = sampleBlock.replace('**Location:** Remote', '**Location:** Austin, TX');
    const job = parseIndeedResults(block)[0];
    assert.equal(job.isRemote, false);
    assert.deepEqual(job.workplaceTypes, ['On-Site']);
  });

  it('sets salary to null when Compensation is N/A', () => {
    const block = sampleBlock.replace('$120,000 - $140,000', 'N/A');
    assert.equal(parseIndeedResults(block)[0].salary, null);
  });

  it('parses multiple job blocks', () => {
    const block2 = `**Job Title:** Staff QE
**Company:** Beta Inc
**Location:** Remote
**Job Id:** def456
**Posted on:** 2025-06-02
**Compensation:** N/A
**Job Type:** Full-time
**View Job URL:** https://indeed.com/job/def456`;
    const jobs = parseIndeedResults(sampleBlock + '\n' + block2);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].companyName, 'Beta Inc');
  });
});
