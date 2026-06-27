/**
 * server.js — tiny local web server (node:http, zero deps).
 *
 * Serves Adli's dashboard and the JSON API that replaces his localStorage + window.cowork seams.
 * The dashboard is served with the current scored jobs injected into Adli's existing
 * PRELOADED_JOBS slot, so the Matches tab shows real data with no round-trip; mutations
 * (activities/dismiss/settings/resumes) go through the JSON API so the crown-jewel compliance
 * log lives in SQLite, not the browser.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { applyDisplayFilters, displayContext } = require('./pipeline');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 5_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/** Inject the current display-filtered jobs into Adli's PRELOADED_JOBS slot. */
function renderDashboard(db) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf8');
  const settings = db.getSettings();
  const jobs = applyDisplayFilters(db.getActiveJobs(), settings, displayContext(db));
  const block = `<script>// PRELOADED_JOBS_START
const PRELOADED_JOBS = ${JSON.stringify(jobs)};
const PRELOADED_TIMESTAMP = ${JSON.stringify(new Date().toISOString())};
// PRELOADED_JOBS_END`;
  html = html.replace(/<script>\/\/ PRELOADED_JOBS_START[\s\S]*?\/\/ PRELOADED_JOBS_END/, block);
  return html;
}

function createServer(db) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      // ─── dashboard ───
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = renderDashboard(db);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }

      // ─── JSON API ───
      if (p === '/api/jobs' && req.method === 'GET') {
        const settings = db.getSettings();
        const jobs = applyDisplayFilters(db.getActiveJobs(), settings, displayContext(db));
        const run = db.lastRun();
        return sendJson(res, 200, {
          jobs, fetchedAt: run ? run.finished_at : null,
          sourceCounts: run && run.source_counts ? JSON.parse(run.source_counts) : {},
          status: run ? run.status : 'none', note: run ? run.note : '',
        });
      }
      if (p === '/api/settings' && req.method === 'GET') return sendJson(res, 200, db.getSettings());
      if (p === '/api/settings' && req.method === 'POST') { db.setSettings(await readBody(req)); return sendJson(res, 200, db.getSettings()); }

      if (p === '/api/activities' && req.method === 'GET') return sendJson(res, 200, db.getActs());
      if (p === '/api/activities' && req.method === 'POST') { const a = await readBody(req); db.putActivity(a); return sendJson(res, 200, { ok: true, id: a.id }); }
      if (p === '/api/activities/delete' && req.method === 'POST') { const { id } = await readBody(req); db.deleteActivity(id); return sendJson(res, 200, { ok: true }); }

      if (p === '/api/dismiss' && req.method === 'POST') { const { guid, reason, job } = await readBody(req); db.dismissJob(guid, reason || '', { job }); return sendJson(res, 200, { ok: true }); }
      if (p === '/api/undismiss' && req.method === 'POST') { const { guid } = await readBody(req); db.undismissJob(guid); return sendJson(res, 200, { ok: true }); }

      if (p === '/api/resumes' && req.method === 'GET') return sendJson(res, 200, db.getResumes());
      if (p === '/api/resumes' && req.method === 'POST') { const r = await readBody(req); db.putResume(r); return sendJson(res, 200, { ok: true }); }
      if (p === '/api/resumes/delete' && req.method === 'POST') { const { id } = await readBody(req); db.deleteResume(id); return sendJson(res, 200, { ok: true }); }

      if (p === '/api/status' && req.method === 'GET') { const run = db.lastRun(); return sendJson(res, 200, { run }); }

      // static assets (docs images, etc.)
      if (req.method === 'GET' && p.startsWith('/docs/')) {
        const fp = path.join(PUBLIC_DIR, '..', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
        if (fp.startsWith(path.join(PUBLIC_DIR, '..')) && fs.existsSync(fp)) {
          res.writeHead(200, { 'content-type': p.endsWith('.png') ? 'image/png' : 'application/octet-stream' });
          return res.end(fs.readFileSync(fp));
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    } catch (e) {
      sendJson(res, 500, { error: String(e && e.message || e) });
    }
  });
}

module.exports = { createServer, renderDashboard };
