/**
 * pipeline.test.js — gather (injected sources) + Adli's display-filter chain + runDaily end-to-end (in-memory).
 * Run: node --test test/pipeline.test.js
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gather, applyDisplayFilters, runDaily, displayContext } = require('../src/pipeline');
const { JobScoutDB } = require('../src/db');

const J = (over) => ({ guid: 'g', title: 'Senior SDET', companyName: 'Acme', jobLocation: { displayName: 'Remote' },
  isRemote: true, workplaceTypes: ['Remote'], salary: '$150k', source: 'JSearch', summary: '', matchScore: 8, ...over });

describe('gather', () => {
  it('runs enabled sources, dedupes, counts per source, carries the canary', async () => {
    const settings = { sources: { jsearch: true, linkedinGuest: true, linkedinRideAlong: false } };
    const r = await gather(settings, {
      jsearchImpl: async () => ({ jobs: [J({ guid: 'js1', source: 'JSearch' })], error: null }),
      linkedinImpl: async () => ({ jobs: [J({ guid: 'li1', title: 'Staff Engineer', companyName: 'Beta', source: 'LinkedIn' })], canary: { ok: true }, error: null }),
    });
    assert.equal(r.jobs.length, 2);
    assert.deepEqual(r.counts, { JSearch: 1, LinkedIn: 1 });
    assert.deepEqual(r.canary, { ok: true });
  });

  it('skips a disabled source and records source errors', async () => {
    const settings = { sources: { jsearch: false, linkedinGuest: true } };
    const r = await gather(settings, {
      jsearchImpl: async () => { throw new Error('should not run'); },
      linkedinImpl: async () => ({ jobs: [], canary: null, error: 'http_429' }),
    });
    assert.equal(r.jobs.length, 0);
    assert.ok(r.errors.includes('linkedin:http_429'));
  });
});

describe('applyDisplayFilters (Adli\'s chain)', () => {
  const settings = { workArrangements: ['remote'], minSalary: 0, defensePreference: 'penalize' };
  it('drops score < 5', () => {
    assert.equal(applyDisplayFilters([J({ matchScore: 4 })], settings).length, 0);
  });
  it('drops dismissed by guid', () => {
    assert.equal(applyDisplayFilters([J({ guid: 'x' })], settings, { dismissedGuids: new Set(['x']) }).length, 0);
  });
  it('drops already-applied by company|title key', () => {
    const ctx = { appliedKeys: new Set(['acme|seniorsdet']) };
    assert.equal(applyDisplayFilters([J()], settings, ctx).length, 0);
  });
  it('excludes defense roles when defensePreference=exclude', () => {
    const s = { ...settings, defensePreference: 'exclude' };
    assert.equal(applyDisplayFilters([J({ title: 'Engineer (Secret clearance)' })], s).length, 0);
  });
  it('enforces min salary', () => {
    const s = { ...settings, minSalary: 200000 };
    assert.equal(applyDisplayFilters([J({ salary: '$150k' })], s).length, 0);
  });
  it('keeps a good remote job and sorts by score desc', () => {
    const out = applyDisplayFilters([J({ guid: 'a', matchScore: 6 }), J({ guid: 'b', matchScore: 9 })], settings);
    assert.deepEqual(out.map(j => j.guid), ['b', 'a']);
  });
});

describe('runDaily (in-memory db, keyword scoring)', () => {
  let tmp, db;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobscout-pipe-')); db = new JobScoutDB(path.join(tmp, 't.db')); });
  afterEach(() => { try { db.close(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });

  it('gathers, scores, writes jobs + a run row, and the dashboard query reflects it', async () => {
    db.setSettings({ scoreProvider: 'keyword', sources: { jsearch: true, linkedinGuest: false, linkedinRideAlong: false } });
    const res = await runDaily(db, db.getSettings(), {
      jsearchImpl: async () => ({ jobs: [
        J({ guid: 'js_keep', title: 'Senior QA Engineer', summary: 'python automation', matchScore: undefined }),
        J({ guid: 'js_junk', title: 'Junior Associate', matchScore: undefined }),
      ], error: null }),
    });
    assert.equal(res.jobCount, 2);
    assert.equal(res.scoredCount, 2);

    // both stored + scored 1-10
    assert.ok(db.getJob('js_keep').matchScore >= 1);
    // display filter: the senior QA job survives, the junior one is below 5
    const ctx = displayContext(db);
    const shown = applyDisplayFilters(db.getActiveJobs(), db.getSettings(), ctx);
    assert.ok(shown.find(j => j.guid === 'js_keep'));
    assert.ok(!shown.find(j => j.guid === 'js_junk'));

    // a run row was recorded
    const run = db.lastRun();
    assert.equal(run.status, 'ok');
    assert.equal(run.job_count, 2);
  });
});
