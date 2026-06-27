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
