/**
 * emlx.js — read job-alert emails from the LOCAL Apple Mail store (macOS), zero deps.
 *
 * This is the truest ShaniSov-style local read: Apple Mail keeps each message as a `.emlx` file
 * (a byte-count line + the raw RFC822 message + a trailing plist) under the ~/Library/Mail/V<n> store.
 * We scan recent ones, keep the ones that look like job alerts, and parse them into jobs. Reading
 * ~/Library/Mail needs Full Disk Access; without it we degrade to a clear error (never a crash).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseMessage } = require('./mime');
const { parseJobAlertEmail, looksLikeJobAlert } = require('./parse');

/** Strip the .emlx byte-count line and return {headers, html} for the embedded RFC822 message. */
function parseEmlx(buf) {
  const nl = buf.indexOf(0x0a);
  if (nl < 0) return { headers: {}, html: '' };
  const count = parseInt(buf.slice(0, nl).toString('ascii').trim(), 10);
  const msg = Number.isFinite(count)
    ? buf.slice(nl + 1, nl + 1 + count).toString('utf8')
    : buf.slice(nl + 1).toString('utf8');
  return parseMessage(msg);
}

function readEmlxFile(file) {
  const { headers, html } = parseEmlx(fs.readFileSync(file));
  return {
    from: headers['from'] || '', subject: headers['subject'] || '', html,
    receivedAt: (() => { const d = Date.parse(headers['date'] || ''); return Number.isFinite(d) ? d : null; })(),
  };
}

/** Find the Apple Mail version dir(s) (~/Library/Mail/V10, V9, …). */
function mailRoots(home = os.homedir()) {
  const base = path.join(home, 'Library', 'Mail');
  try {
    return fs.readdirSync(base).filter(n => /^V\d+$/.test(n)).map(n => path.join(base, n));
  } catch { return []; }
}

/** Bounded recursive walk collecting recent .emlx files (newest first). */
function collectRecentEmlx(roots, { sinceMs, maxFiles = 600, maxVisit = 20000 }) {
  const found = [];
  let visited = 0;
  const stack = [...roots];
  while (stack.length && visited < maxVisit) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      visited++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.name.endsWith('.emlx')) continue;
      try { const st = fs.statSync(full); if (st.mtimeMs >= sinceMs) found.push({ full, mtime: st.mtimeMs }); } catch {}
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, maxFiles).map(f => f.full);
}

/**
 * Scan the local Apple Mail store for recent job-alert emails → jobs.
 * @returns {Promise<{jobs:object[], error:string|null, scanned:number}>}
 */
async function scanAppleMail(opts = {}) {
  if (process.platform !== 'darwin') return { jobs: [], error: 'not_macos', scanned: 0 };
  const roots = mailRoots(opts.home);
  if (!roots.length) return { jobs: [], error: 'no_mail_store_or_no_full_disk_access', scanned: 0 };
  const days = opts.days || 14;
  const sinceMs = Date.now() - days * 86400000;
  let files;
  try { files = collectRecentEmlx(roots, { sinceMs, maxFiles: opts.maxFiles || 600 }); }
  catch (e) { return { jobs: [], error: String(e && e.message || e), scanned: 0 }; }

  const all = [];
  const seen = new Set();
  for (const file of files) {
    let email;
    try { email = readEmlxFile(file); } catch { continue; }
    if (!looksLikeJobAlert(email)) continue;
    for (const j of parseJobAlertEmail(email)) if (!seen.has(j.guid)) { seen.add(j.guid); all.push(j); }
  }
  return { jobs: all, error: all.length ? null : (files.length ? null : 'no_recent_messages'), scanned: files.length };
}

module.exports = { scanAppleMail, parseEmlx, readEmlxFile, mailRoots, collectRecentEmlx };
