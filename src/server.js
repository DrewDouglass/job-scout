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
const { tailorResume, homeDir } = require('./tailor');

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

/** Build the dashboard's seed state from SQLite (mirrors the jd_* localStorage keys). */
function buildSeedState(db) {
  return {
    jd_settings: db.getSettings(),
    jd_activities: db.getActs(),
    jd_dismissed: db.getDismissedMap(),
    jd_resumes: db.getResumes(),
    jd_job_cache: db.getJobsCacheMap(),
    jd_applications: {}, // legacy/derived (markApplied writes an activity, which IS persisted)
  };
}

/**
 * The localStorage shim, injected BEFORE Adli's script runs (the dashboard boots by calling run()
 * at the end of its main script). It overrides Storage.prototype's get/set/removeItem for the six
 * jd_* keys: reads come from the SQLite-seeded snapshot, writes mirror to the JSON API so the data
 * lives in SQLite — not the browser. Adli's ~12 storage helpers are untouched and keep working.
 */
function lsShimScript(seed) {
  return `
window.__JOBSCOUT_STATE__ = ${JSON.stringify(seed)};
(function(){
  var seed = window.__JOBSCOUT_STATE__ || {};
  var mem = {}; for (var k in seed) mem[k] = JSON.stringify(seed[k]);
  var KEYS = { jd_settings:1, jd_job_cache:1, jd_applications:1, jd_dismissed:1, jd_activities:1, jd_resumes:1 };
  var EP = { jd_settings:['/api/settings', function(p){return p;}],
             jd_activities:['/api/activities/replace', function(p){return {acts:p};}],
             jd_dismissed:['/api/dismissed/replace', function(p){return {map:p};}],
             jd_resumes:['/api/resumes/replace', function(p){return {resumes:p};}] };
  function post(key, val){
    var ep = EP[key]; if(!ep) return; // jd_job_cache + jd_applications stay client-only (derived/legacy)
    var p; try { p = JSON.parse(val); } catch(e){ return; }
    fetch(ep[0], {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(ep[1](p))}).catch(function(){});
  }
  var SP = window.Storage && window.Storage.prototype; if(!SP) return;
  var g = SP.getItem, s = SP.setItem, r = SP.removeItem;
  SP.getItem = function(key){ if(this===window.localStorage && KEYS[key]) return (key in mem)?mem[key]:null; return g.call(this,key); };
  SP.setItem = function(key,val){ if(this===window.localStorage && KEYS[key]){ mem[key]=String(val); post(key,String(val)); return; } return s.call(this,key,val); };
  SP.removeItem = function(key){ if(this===window.localStorage && KEYS[key]){ delete mem[key]; if(key==='jd_settings') fetch('/api/settings/reset',{method:'POST'}).catch(function(){}); return; } return r.call(this,key); };
})();`;
}

/** Repoint Live Search → server refresh, and neutralize the Cowork-only metro autofill. Runs AFTER Adli's script. */
const TRAILER_SCRIPT = `<script>
window.refreshNow = async function(){
  var b = document.getElementById('btn-live-search');
  if(b){ b.disabled=true; b.textContent='\\u23F3 Refreshing\\u2026'; }
  try { await fetch('/api/refresh', {method:'POST'}); } catch(e){}
  location.reload();
};
(function(){ var b=document.getElementById('btn-live-search'); if(b) b.setAttribute('onclick','refreshNow()'); })();
window.autoFillMetroCities = function(){
  var s=document.getElementById('autofill-status');
  if(s){ s.textContent='Enter your metro cities manually here (auto-fill needs an AI provider).'; s.style.color='#dc2626'; }
};
</script>`;

/** Serve Adli's dashboard with: scored jobs injected, the SQLite-backed localStorage shim, and the trailer. */
function renderDashboard(db) {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf8');
  const settings = db.getSettings();
  const jobs = applyDisplayFilters(db.getActiveJobs(), settings, displayContext(db));
  const seed = buildSeedState(db);
  const run = db.lastRun();
  const block = `<script>// PRELOADED_JOBS_START
const PRELOADED_JOBS = ${JSON.stringify(jobs)};
const PRELOADED_TIMESTAMP = ${JSON.stringify(new Date().toISOString())};
const PRELOADED_RUN_NOTE = ${JSON.stringify(run ? (run.note || '') : '')};
${lsShimScript(seed)}
// PRELOADED_JOBS_END`;
  html = html.replace(/<script>\/\/ PRELOADED_JOBS_START[\s\S]*?\/\/ PRELOADED_JOBS_END/, block);
  html = html.replace('</body>', `${TRAILER_SCRIPT}\n</body>`);
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

      if (p === '/api/settings/reset' && req.method === 'POST') { db.resetSettings(); return sendJson(res, 200, db.getSettings()); }

      if (p === '/api/activities' && req.method === 'GET') return sendJson(res, 200, db.getActs());
      if (p === '/api/activities' && req.method === 'POST') { const a = await readBody(req); if (!a || a.id == null) return sendJson(res, 400, { error: 'activity requires an id' }); db.putActivity(a); return sendJson(res, 200, { ok: true, id: a.id }); }
      if (p === '/api/activities/delete' && req.method === 'POST') { const { id } = await readBody(req); db.deleteActivity(id); return sendJson(res, 200, { ok: true }); }
      if (p === '/api/activities/replace' && req.method === 'POST') { const { acts } = await readBody(req); db.replaceActivities(acts || {}); return sendJson(res, 200, { ok: true }); }

      if (p === '/api/dismiss' && req.method === 'POST') { const { guid, reason, job } = await readBody(req); db.dismissJob(guid, reason || '', { job }); return sendJson(res, 200, { ok: true }); }
      if (p === '/api/undismiss' && req.method === 'POST') { const { guid } = await readBody(req); db.undismissJob(guid); return sendJson(res, 200, { ok: true }); }
      if (p === '/api/dismissed/replace' && req.method === 'POST') { const { map } = await readBody(req); db.replaceDismissed(map || {}); return sendJson(res, 200, { ok: true }); }

      if (p === '/api/resumes' && req.method === 'GET') return sendJson(res, 200, db.getResumes());
      if (p === '/api/resumes' && req.method === 'POST') { const r = await readBody(req); db.putResume(r); return sendJson(res, 200, { ok: true }); }
      if (p === '/api/resumes/delete' && req.method === 'POST') { const { id } = await readBody(req); db.deleteResume(id); return sendJson(res, 200, { ok: true }); }
      if (p === '/api/resumes/replace' && req.method === 'POST') { const { resumes } = await readBody(req); db.replaceResumes(resumes || []); return sendJson(res, 200, { ok: true }); }

      if (p === '/api/status' && req.method === 'GET') { const run = db.lastRun(); return sendJson(res, 200, { run }); }

      // resume tailoring — end-to-end (.docx + .pdf), using the configured AI provider + the saved base resume
      if (p === '/api/tailor' && req.method === 'POST') {
        const { guid } = await readBody(req);
        const job = db.getJob(guid);
        if (!job) return sendJson(res, 200, { ok: false, error: 'job_not_found' });
        const settings = db.getSettings();
        try {
          const r = await tailorResume(db, { job, baseResumeText: settings.baseResume || '', settings });
          return sendJson(res, 200, { ok: true, docxFile: r.docxFile, pdfFile: r.pdfFile });
        } catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
      }
      // download a generated resume file (sanitized to the resumes dir)
      if (p === '/download' && req.method === 'GET') {
        const resumesDir = path.join(homeDir(), 'resumes');
        const name = path.basename(url.searchParams.get('file') || '');
        const fp = path.join(resumesDir, name);
        if (name && fp.startsWith(resumesDir) && fs.existsSync(fp)) {
          const ct = name.endsWith('.pdf') ? 'application/pdf'
            : name.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/octet-stream';
          res.writeHead(200, { 'content-type': ct, 'content-disposition': `attachment; filename="${name}"` });
          return res.end(fs.readFileSync(fp));
        }
        res.writeHead(404); return res.end('not found');
      }
      if (p === '/api/generate-profile' && req.method === 'POST') {
        const settings = db.getSettings();
        const baseResume = (settings.baseResume || '').trim();
        if (!baseResume) return sendJson(res, 200, { ok: false, error: 'no_base_resume' });
        const provider = settings.scoreProvider || 'keyword';
        if (provider === 'keyword') return sendJson(res, 200, { ok: false, error: 'needs_ai_provider' });
        const { generateJSON } = require('./scoring/ai');
        const schema = {
          type: 'object', additionalProperties: false, required: ['name', 'location', 'summary'],
          properties: {
            name:     { type: 'string' },
            location: { type: 'string' },
            summary:  { type: 'string' },
          },
        };
        try {
          const result = await generateJSON({
            provider,
            prompt: `Extract three fields from this resume:\n\n- "name": the candidate's full name from the header\n- "location": city/state from the header (e.g. "Boulder, CO")\n- "summary": a comprehensive skills and background profile for AI job scoring. Write 3-5 sentences in first person covering: total years of experience, ALL specific tools/frameworks/languages/platforms mentioned ANYWHERE in the resume (read the full experience bullets, not just the top summary), seniority level, and domain expertise. Be specific and complete — list the actual technologies by name.\n\nRESUME:\n${baseResume.slice(0, 8000)}`,
            schema,
            system: 'You extract structured data from a resume. Read the entire document including all experience bullets before writing the summary. Return only JSON.',
            opts: { anthropicKey: settings.anthropicKey || process.env.ANTHROPIC_API_KEY },
          });
          if (result && result.summary) return sendJson(res, 200, { ok: true, name: result.name || '', location: result.location || '', summary: result.summary });
          return sendJson(res, 200, { ok: false, error: 'no_output' });
        } catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
      }

      if (p === '/api/extract-skills' && req.method === 'POST') {
        const settings = db.getSettings();
        const body = await readBody(req);
        const baseResume = (body.resume || settings.baseResume || '').trim();
        if (!baseResume) return sendJson(res, 200, { ok: false, error: 'no_base_resume' });
        const provider = settings.scoreProvider || 'keyword';
        if (provider === 'keyword') return sendJson(res, 200, { ok: false, error: 'needs_ai_provider' });
        const { generateJSON } = require('./scoring/ai');
        const schema = {
          type: 'object', additionalProperties: false, required: ['skills'],
          properties: {
            skills: {
              type: 'array',
              items: {
                type: 'object', additionalProperties: false, required: ['name', 'years', 'confidence'],
                properties: {
                  name:       { type: 'string' },
                  years:      { type: 'integer' },
                  confidence: { type: 'integer' },
                },
              },
            },
          },
        };
        try {
          const result = await generateJSON({
            provider,
            prompt: `Extract skills from this resume. Return a JSON object with a "skills" array. For each skill include: name (concise, e.g. "Python/pytest", "REST API Testing", "Kubernetes"), years of experience (integer, estimate from job dates), confidence 1-5 (5=expert, daily use; 4=strong professional; 3=solid working knowledge; 2=some experience; 1=basic familiarity). Include technical tools, languages, frameworks, platforms, methodologies. Do not include soft skills.\n\nRESUME:\n${baseResume.slice(0, 8000)}`,
            schema,
            system: 'You extract structured skill data from a resume. Read all experience bullets carefully. Return only JSON.',
            opts: { anthropicKey: settings.anthropicKey || process.env.ANTHROPIC_API_KEY },
          });
          if (result && Array.isArray(result.skills) && result.skills.length) {
            return sendJson(res, 200, { ok: true, skills: result.skills });
          }
          return sendJson(res, 200, { ok: false, error: 'no_output' });
        } catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
      }

      if (p === '/api/test-provider' && req.method === 'POST') {
        const settings = db.getSettings();
        const provider = settings.scoreProvider || 'keyword';
        if (provider === 'keyword') return sendJson(res, 200, { ok: true, provider: 'keyword' });
        const { generateJSON } = require('./scoring/ai');
        const schema = {
          type: 'object', additionalProperties: false, required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        };
        try {
          const result = await generateJSON({
            provider,
            prompt: 'Reply with {"ok":true}.',
            schema,
            system: 'Return only JSON.',
            opts: { anthropicKey: settings.anthropicKey || process.env.ANTHROPIC_API_KEY },
          });
          if (result && result.ok) return sendJson(res, 200, { ok: true, provider });
          return sendJson(res, 200, { ok: false, error: 'unexpected_response', provider });
        } catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e), provider }); }
      }

      if (p === '/api/refresh' && req.method === 'POST') {
        const { runDaily } = require('./pipeline');
        try { const r = await runDaily(db, db.getSettings(), {}); return sendJson(res, 200, { ok: true, ...r }); }
        catch (e) { return sendJson(res, 200, { ok: false, error: String(e && e.message || e) }); }
      }

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
