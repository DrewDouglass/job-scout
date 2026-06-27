/**
 * observer.js — the LinkedIn ride-along driver (zero npm deps; Node global WebSocket+fetch).
 *
 * Adapted from Sovereign's proven, shipped `scripts/linkedin-observer/observer.mjs` (a CDP
 * driver that rides a dedicated logged-in Chrome). The DM observer is pure observe-only;
 * for JOBS a job-seeker won't naturally browse, so this driver NAVIGATES the dedicated Chrome
 * to the user's OWN saved job-search URLs at human cadence and captures the Voyager job-card
 * responses the page emits. It rides the user's own session/residential IP — NO crafted API
 * calls, no auto-apply, no bulk history — so it stays in the documented low-ban-risk observe tier
 * (project_shani_linkedin_ridealong_answer_2026_06_18).
 *
 * Dedicated, ISOLATED Chrome profile (NOT the user's daily browser; no extension → dodges
 * LinkedIn's BrowserGate extension-ID probe). One-time HEADFUL login persists li_at in the
 * profile; capture runs HEADLESS thereafter against the same profile.
 *
 * CLI:  node src/sources/linkedin/observer.js login   # one-time headful sign-in
 *       node src/sources/linkedin/observer.js probe    # log matching LinkedIn job URLs (discovery)
 *       node src/sources/linkedin/observer.js capture --url "<saved search url>"
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findChrome } = require('./chrome');

// Job-scout's OWN CDP port. Deliberately NOT 9222 (Chrome's default debug port), so we never
// collide with another debug-Chrome the user runs — e.g. a separate LinkedIn observer. Overridable.
const PORT = Number(process.env.LINKEDIN_CDP_PORT || 9239);
const PROFILE_DIR = process.env.LINKEDIN_CHROME_PROFILE
  || path.join(process.env.JOB_SCOUT_HOME || path.join(os.homedir(), '.job-scout'), 'linkedin', 'chrome-profile');
// URLs the jobs page fetches for the cards. Match by SUBSTRING — never the rotating queryId/decorationId.
const JOB_CARDS_URL_RE = /voyagerJobsDashJobCards|graphql.*JobCards|jobs\/jobPostings/i;

function log(...p) { process.stderr.write(`[linkedin ${new Date().toISOString()}] ${p.join(' ')}\n`); }

// ─── tiny zero-dep CDP client (JSON over the DevTools websocket) ────────────────
class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this._id = 0; this._pending = new Map(); this._handlers = new Map(); this.ws = null; this.closed = false; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl); this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(e?.error || new Error('CDP websocket error')));
      ws.addEventListener('message', (ev) => this._onMessage(typeof ev.data === 'string' ? ev.data : ''));
      ws.addEventListener('close', () => { this.closed = true; for (const { reject } of this._pending.values()) { try { reject(new Error('CDP closed')); } catch {} } this._pending.clear(); });
    });
  }
  _onMessage(data) {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.id != null && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id); this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'CDP error')); else resolve(msg.result);
    } else if (msg.method) {
      const cbs = this._handlers.get(msg.method);
      if (cbs) for (const cb of cbs) { try { cb(msg.params || {}, msg.sessionId); } catch (e) { log('handler err', msg.method, e.message); } }
    }
  }
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('CDP closed'));
    const id = ++this._id;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(`CDP ${method} timed out`)); } }, timeoutMs);
      this._pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try { this.ws.send(JSON.stringify(payload)); } catch (e) { clearTimeout(timer); this._pending.delete(id); reject(e); }
    });
  }
  on(method, cb) { if (!this._handlers.has(method)) this._handlers.set(method, []); this._handlers.get(method).push(cb); }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function cdpReachable(port = PORT) { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } }

// When we launch Chrome we drop a sentinel in OUR profile dir recording {port,pid}. That is how we
// later prove a Chrome on the port is the one WE launched (DevTools' own DevToolsActivePort file is
// unreliable for headful Chrome). A different tool's Chrome uses a different profile dir, so it never
// has our sentinel — we never silently attach to a stranger's (wrong-account) session.
const sentinelPath = (profileDir) => path.join(profileDir, '.jobscout-cdp.json');
function writeSentinel(profileDir, port, pid) {
  try { fs.mkdirSync(profileDir, { recursive: true }); fs.writeFileSync(sentinelPath(profileDir), JSON.stringify({ port, pid })); } catch {}
}
/** True only if the live Chrome on `port` is the one we launched (sentinel matches AND its pid is alive). */
function ownsCdp(port, profileDir) {
  try {
    const s = JSON.parse(fs.readFileSync(sentinelPath(profileDir), 'utf8'));
    if (Number(s.port) !== Number(port)) return false;
    if (s.pid) { try { process.kill(s.pid, 0); } catch { return false; } }   // the Chrome we launched must still be running
    return true;
  } catch { return false; }
}

/** Launch the dedicated Chrome (headful for login, headless for capture). Detached so it outlives this process. */
async function launchChrome({ headless = true, port = PORT, profileDir = PROFILE_DIR, startUrl = 'https://www.linkedin.com/jobs/' } = {}) {
  if (await cdpReachable(port)) {
    // Only reuse a Chrome that is genuinely ours — never silently attach to a different debug-Chrome
    // (e.g. another LinkedIn observer), which would read the WRONG account's session.
    if (ownsCdp(port, profileDir)) { log(`reusing job-scout's Chrome on :${port}`); return { reused: true }; }
    throw new Error(`Port ${port} is already in use by a different Chrome (not job-scout). Close it, or set LINKEDIN_CDP_PORT to a free port and retry.`);
  }
  const bin = findChrome();
  if (!bin) throw new Error('Chrome/Chromium not found. Install Chrome or set CHROME_PATH.');
  fs.mkdirSync(profileDir, { recursive: true });
  const args = [
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling',
  ];
  if (headless) args.push('--headless=new', '--window-size=1280,2000');
  args.push(startUrl);
  log(`launching ${headless ? 'headless' : 'HEADFUL'} dedicated Chrome (${bin})`);
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 60; i++) { if (await cdpReachable(port)) { writeSentinel(profileDir, port, child.pid); log('dedicated Chrome CDP up'); return { reused: false, pid: child.pid }; } await sleep(500); }
  throw new Error(`Chrome did not expose CDP on :${port} within 30s`);
}

/** Attach to (or open) a LinkedIn page target and Network.enable it; returns the CDP + sessionId. */
async function attachPage(port = PORT) {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await cdp.send('Target.getTargets', {});
  let target = (targetInfos || []).find(t => t.type === 'page' && /linkedin\.com/i.test(t.url || ''))
    || (targetInfos || []).find(t => t.type === 'page');
  if (!target) { const r = await cdp.send('Target.createTarget', { url: 'https://www.linkedin.com/jobs/' }); target = { targetId: r.targetId }; }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  return { cdp, sessionId };
}

/** li_at cookie present + unexpired = session alive (pure CDP read, no LinkedIn request). */
async function sessionAlive(cdp, sessionId) {
  try {
    const { cookies } = await cdp.send('Network.getCookies', { urls: ['https://www.linkedin.com'] }, sessionId);
    const li = (cookies || []).find(c => c.name === 'li_at');
    return !!(li && li.value && (li.expires === undefined || li.expires === -1 || li.expires * 1000 > Date.now()));
  } catch { return false; }
}

/**
 * Drive the dedicated Chrome to each saved-search URL and capture the job-card responses.
 * @returns {Promise<{captures:object[], statuses:number[], matchedResponses:number, sessionAlive:boolean}>}
 */
async function captureSavedSearches(searchUrls, { port = PORT, scrolls = 3, settleMs = 2500, probe = false } = {}) {
  const { cdp, sessionId } = await attachPage(port);
  const captures = [];
  const statuses = [];
  let matched = 0;
  const inflight = new Map(); // requestId -> url

  cdp.on('Network.responseReceived', (p, sid) => {
    if (sid !== sessionId) return;
    const url = p.response?.url || '';
    if (!JOB_CARDS_URL_RE.test(url)) return;
    matched++; statuses.push(p.response?.status || 0);
    if (probe) { log('job-cards response', (p.response?.status || ''), url.slice(0, 140)); return; }
    inflight.set(p.requestId, url);
  });
  cdp.on('Network.loadingFinished', async (p, sid) => {
    if (sid !== sessionId || !inflight.has(p.requestId)) return;
    inflight.delete(p.requestId);
    try {
      const r = await cdp.send('Network.getResponseBody', { requestId: p.requestId }, sessionId);
      const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
      const parsed = JSON.parse(body);
      captures.push(parsed);
    } catch { /* body evicted or non-JSON — harmless; the canary catches a true empty */ }
  });

  const alive = await sessionAlive(cdp, sessionId);
  if (!alive) { log('LinkedIn session not alive (li_at missing/expired) — run `login` first'); cdp.close(); return { captures, statuses, matchedResponses: matched, sessionAlive: false }; }

  for (const url of (searchUrls || [])) {
    log(`navigate ${url.slice(0, 120)}`);
    try {
      await cdp.send('Page.navigate', { url }, sessionId);
      await sleep(settleMs);
      for (let s = 0; s < scrolls; s++) {
        await cdp.send('Runtime.evaluate', { expression: 'window.scrollBy(0, document.body.scrollHeight)' }, sessionId).catch(() => {});
        await sleep(settleMs);
      }
    } catch (e) { log('navigate/scroll failed:', e.message); }
  }
  await sleep(settleMs); // let trailing loadingFinished events drain
  cdp.close();
  return { captures, statuses, matchedResponses: matched, sessionAlive: alive };
}

// ─── CLI (one-time login / discovery probe / a manual capture) ─────────────────
async function runCli(argv) {
  const mode = argv[2] || 'login';
  if (mode === 'login') {
    await launchChrome({ headless: false, startUrl: 'https://www.linkedin.com/login' });
    process.stdout.write(
`A dedicated Chrome window is opening. Sign in to LinkedIn (including 2FA) and leave it signed in, then close the window.
Your login persists in: ${PROFILE_DIR}
After that, capture runs headless against this profile. Re-run this 'login' command whenever the canary says your session expired.\n`);
    return;
  }
  if (mode === 'probe' || mode === 'capture') {
    const urlIdx = argv.indexOf('--url');
    const url = urlIdx !== -1 ? argv[urlIdx + 1] : 'https://www.linkedin.com/jobs/search/?keywords=software%20engineer&f_WT=2';
    await launchChrome({ headless: true });
    const res = await captureSavedSearches([url], { probe: mode === 'probe' });
    process.stdout.write(`sessionAlive=${res.sessionAlive} matchedResponses=${res.matchedResponses} captures=${res.captures.length} statuses=${JSON.stringify(res.statuses)}\n`);
    return;
  }
  process.stderr.write(`unknown mode: ${mode} (use login | probe | capture)\n`);
  process.exit(1);
}

if (require.main === module) runCli(process.argv).catch(e => { log('fatal:', e.stack || e.message); process.exit(1); });

module.exports = { launchChrome, attachPage, captureSavedSearches, sessionAlive, runCli, ownsCdp, PROFILE_DIR, PORT, JOB_CARDS_URL_RE };
