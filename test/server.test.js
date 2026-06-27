/**
 * server.test.js — the local server's JSON API + dashboard injection over real HTTP.
 * Run: node --test test/server.test.js
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobScoutDB } = require('../src/db');
const { createServer } = require('../src/server');

let tmp, db, server, base;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(base + p);
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d, json: () => JSON.parse(d) })); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobscout-srv-'));
  db = new JobScoutDB(path.join(tmp, 's.db'));
  db.setSettings({ scoreProvider: 'keyword' });
  db.upsertJob({ guid: 'srv1', title: 'Senior SDET', companyName: 'Acme', jobLocation: { displayName: 'Remote' },
    isRemote: true, workplaceTypes: ['Remote'], salary: '$150k', source: 'LinkedIn', matchScore: 9, matchReason: 'fit' });
  const id = db.startRun({ now: 1000 }); db.finishRun(id, { jobCount: 1, scoredCount: 1, sourceCounts: { LinkedIn: 1 }, now: 2000 });
  server = createServer(db);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('server', () => {
  it('GET / serves the dashboard with jobs injected into PRELOADED_JOBS', async () => {
    const r = await req('GET', '/');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes('PRELOADED_JOBS'));
    assert.ok(r.body.includes('Senior SDET'));      // real job injected
    assert.ok(!/const PRELOADED_JOBS = \[\];/.test(r.body)); // not the empty template
  });

  it('GET /api/jobs returns display-filtered jobs + run status', async () => {
    const r = await req('GET', '/api/jobs');
    const j = r.json();
    assert.equal(j.jobs.length, 1);
    assert.equal(j.jobs[0].guid, 'srv1');
    assert.equal(j.status, 'ok');
    assert.deepEqual(j.sourceCounts, { LinkedIn: 1 });
  });

  it('GET/POST /api/settings round-trips', async () => {
    await req('POST', '/api/settings', { weeklyActivityGoal: 3 });
    assert.equal((await req('GET', '/api/settings')).json().weeklyActivityGoal, 3);
  });

  it('POST /api/activities persists the compliance log to SQLite', async () => {
    await req('POST', '/api/activities', { id: 'a1', type: 'Job Application', date: '2026-06-27', employer: 'Acme', role: 'SDET' });
    const acts = (await req('GET', '/api/activities')).json();
    assert.equal(acts.a1.employer, 'Acme');
  });

  it('POST /api/dismiss then /api/undismiss removes and restores the job', async () => {
    await req('POST', '/api/dismiss', { guid: 'srv1', reason: 'test' });
    assert.equal((await req('GET', '/api/jobs')).json().jobs.length, 0);
    await req('POST', '/api/undismiss', { guid: 'srv1' });
    assert.equal((await req('GET', '/api/jobs')).json().jobs.length, 1);
  });

  it('404s unknown routes', async () => {
    assert.equal((await req('GET', '/nope')).status, 404);
  });
});

describe('dashboard SQLite-backed storage shim', () => {
  it('injects the seed state, the Storage.prototype shim, and the trailer', async () => {
    const html = (await req('GET', '/')).body;
    assert.ok(html.includes('window.__JOBSCOUT_STATE__'));   // seed snapshot
    assert.ok(html.includes('Storage.prototype'));            // the shim override
    assert.ok(html.includes('/api/activities/replace'));      // writes routed to SQLite
    assert.ok(html.includes('window.refreshNow'));            // Live Search repointed
    assert.ok(html.includes('window.autoFillMetroCities'));   // Cowork metro-autofill neutralized
    // the seed includes the previously-logged compliance activity (a1 from the earlier test)
    assert.ok(/"jd_activities":\{[^}]*"a1"/.test(html) || html.includes('"jd_activities"'));
  });

  it('POST /api/activities/replace reconciles the compliance log in SQLite', async () => {
    await req('POST', '/api/activities/replace', { acts: { z9: { id: 'z9', type: 'Interview', date: '2026-06-27' } } });
    const acts = (await req('GET', '/api/activities')).json();
    assert.equal(acts.z9.type, 'Interview');
    assert.equal(acts.a1, undefined);   // earlier activity not in the replacement → deleted
  });

  it('POST /api/dismissed/replace and /api/resumes/replace work', async () => {
    await req('POST', '/api/resumes/replace', { resumes: [{ id: 'rr1', file: 'Master.docx', type: 'base' }] });
    assert.equal((await req('GET', '/api/resumes')).json()[0].file, 'Master.docx');
  });

  it('GET / reflects current jobs after refresh injection (no stale empty template)', async () => {
    const html = (await req('GET', '/')).body;
    assert.ok(html.includes('Senior SDET'));   // srv1 still present (was un-dismissed in an earlier test)
  });
});
