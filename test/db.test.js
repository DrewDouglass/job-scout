/**
 * db.test.js — node:sqlite storage layer + lossless migrate from an Adli backup.
 * Run: node --test test/db.test.js
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobScoutDB, DEFAULT_SETTINGS } = require('../src/db');

let tmpDir, db;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobscout-db-'));
  db = new JobScoutDB(path.join(tmpDir, 'test.db'));
});
afterEach(() => {
  try { db.close(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('settings', () => {
  it('returns defaults when empty', () => {
    assert.equal(db.getSettings().weeklyActivityGoal, 5);
    assert.equal(db.getSettings().scoreProvider, 'keyword');
  });
  it('merges stored overrides onto defaults', () => {
    db.setSettings({ weeklyActivityGoal: 3, scorePenaltyTerms: ['java', 'c#'] });
    const s = db.getSettings();
    assert.equal(s.weeklyActivityGoal, 3);
    assert.deepEqual(s.scorePenaltyTerms, ['java', 'c#']);
    assert.equal(s.candidateName, ''); // untouched default still present
  });
});

describe('jobs', () => {
  const job = (over) => ({
    guid: 'g1', title: 'Senior QE', companyName: 'Acme',
    jobLocation: { displayName: 'Remote' }, salary: '$150k', isRemote: true,
    workplaceTypes: ['Remote'], source: 'JSearch', summary: '', matchScore: 8, matchReason: 'fit', ...over,
  });

  it('upserts and round-trips a job into Adli\'s shape', () => {
    db.upsertJob(job());
    const got = db.getJob('g1');
    assert.equal(got.companyName, 'Acme');
    assert.equal(got.jobLocation.displayName, 'Remote');
    assert.equal(got.isRemote, true);
    assert.deepEqual(got.workplaceTypes, ['Remote']);
    assert.equal(got.matchScore, 8);
  });

  it('getActiveJobs is highest-score first and excludes dismissed', () => {
    db.upsertJob(job({ guid: 'a', matchScore: 6 }));
    db.upsertJob(job({ guid: 'b', matchScore: 9 }));
    db.upsertJob(job({ guid: 'c', matchScore: 7 }));
    db.dismissJob('c', 'not interested');
    const active = db.getActiveJobs();
    assert.deepEqual(active.map(j => j.guid), ['b', 'a']);
  });

  it('dismiss is reversible (the gap Adli could not do) and survives in the dedup map', () => {
    db.upsertJob(job({ guid: 'x' }));
    db.dismissJob('x', 'too junior');
    assert.equal(db.getActiveJobs().length, 0);
    const dmap = db.getDismissedMap();
    assert.equal(dmap.x.reason, 'too junior');
    assert.equal(dmap.x.title, 'Senior QE'); // company|title key preserved for cross-repost filtering
    db.undismissJob('x');
    assert.equal(db.getActiveJobs().length, 1);
    assert.equal(Object.keys(db.getDismissedMap()).length, 0);
  });

  it('dismissing an uncached job creates a stub so its dedup key survives', () => {
    db.dismissJob('ghost', 'spam', { job: { guid: 'ghost', companyName: 'Spammy', title: 'Crypto Bro' } });
    assert.equal(db.getDismissedMap().ghost.companyName, 'Spammy');
  });

  it('upsert preserves first_seen_at and dismissal on re-scan', () => {
    db.upsertJob(job({ guid: 'k' }), { now: 1000 });
    db.dismissJob('k', 'x');
    db.upsertJob(job({ guid: 'k', matchScore: 10 }), { now: 2000 }); // re-scored later
    assert.equal(db.getActiveJobs().length, 0); // still dismissed
    assert.equal(db.getDismissedMap().k.reason, 'x');
  });
});

describe('activities', () => {
  it('put/get/delete', () => {
    db.putActivity({ id: 'act1', type: 'Job Application', date: '2026-06-27', employer: 'Acme', role: 'QE', appStatus: 'applied', createdAt: 1 });
    const acts = db.getActs();
    assert.equal(acts.act1.employer, 'Acme');
    assert.equal(acts.act1.appStatus, 'applied');
    db.deleteActivity('act1');
    assert.equal(Object.keys(db.getActs()).length, 0);
  });
});

describe('runs', () => {
  it('start/finish and lastRun', () => {
    const id = db.startRun({ now: 100 });
    db.finishRun(id, { jobCount: 12, scoredCount: 10, sourceCounts: { JSearch: 12 }, now: 200 });
    const r = db.lastRun();
    assert.equal(r.job_count, 12);
    assert.equal(r.status, 'ok');
    assert.deepEqual(JSON.parse(r.source_counts), { JSearch: 12 });
  });
});

describe('migrate from Adli backup', () => {
  const backup = {
    exportedAt: '2026-06-27T00:00:00Z', version: '1',
    data: {
      jd_settings: JSON.stringify({ weeklyActivityGoal: 5, candidateName: 'Drew', scorePenaltyTerms: ['java'] }),
      jd_activities: JSON.stringify({
        act_a: { id: 'act_a', type: 'Job Application', date: '2026-06-01', employer: 'Acme', role: 'QE', appStatus: 'applied', createdAt: 1 },
        act_b: { id: 'act_b', type: 'Networking', date: '2026-06-02', employer: 'X', createdAt: 2 },
      }),
      jd_dismissed: JSON.stringify({
        d1: { reason: 'defense', dismissedAt: 50, companyName: 'Lockheed', title: 'Cleared Eng' },
      }),
      jd_resumes: JSON.stringify([
        { id: 'r1', file: 'Drew_Master.docx', type: 'base', folder: 'resumes/', archived: false },
      ]),
      jd_job_cache: JSON.stringify({
        j1: { guid: 'j1', title: 'SDET', companyName: 'Beta', jobLocation: { displayName: 'Remote' }, isRemote: true, source: 'Dice', matchScore: 7 },
      }),
    },
  };

  it('imports every key with count parity and preserves the compliance log', () => {
    const counts = db.migrateFromBackup(backup);
    assert.equal(counts.activities, 2);
    assert.equal(counts.dismissed, 1);
    assert.equal(counts.resumes, 1);
    assert.equal(counts.jobs, 1);

    // activities count matches source exactly (never drop a compliance row)
    assert.equal(Object.keys(db.getActs()).length, 2);
    // settings merged
    assert.equal(db.getSettings().candidateName, 'Drew');
    assert.deepEqual(db.getSettings().scorePenaltyTerms, ['java']);
    // dismissed preserved with its dedup key
    assert.equal(db.getDismissedMap().d1.companyName, 'Lockheed');
    // job cache imported and queryable
    assert.equal(db.getJob('j1').companyName, 'Beta');
    // resume imported
    assert.equal(db.getResumes()[0].file, 'Drew_Master.docx');
  });

  it('handles raw (already-parsed) objects too', () => {
    const raw = { data: { jd_activities: { a: { id: 'a', type: 'Interview', date: '2026-06-03', createdAt: 1 } } } };
    const counts = db.migrateFromBackup(raw);
    assert.equal(counts.activities, 1);
    assert.equal(db.getActs().a.type, 'Interview');
  });
});
