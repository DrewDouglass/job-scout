/**
 * chrome.js — cross-OS Chrome/Chromium locator (portability for the Boat: Mac/Win/Linux).
 *
 * The ride-along needs a real Chrome/Chromium to ride the user's own logged-in session.
 * Resolution order: $CHROME_PATH override → per-OS well-known absolute paths → PATH lookup.
 * Pure selection logic (filesystem + PATH probes injected) so it is testable offline.
 */

const fsReal = require('node:fs');
const { execFileSync } = require('node:child_process');

const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    // %LOCALAPPDATA% expanded below
  ],
  linux: [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  ],
};
const PATH_NAMES = {
  darwin: [],
  win32: ['chrome.exe'],
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
};

/**
 * @param {object} [deps]
 * @param {string} [deps.platform]  — process.platform
 * @param {object} [deps.env]       — process.env
 * @param {(p:string)=>boolean} [deps.existsSync]
 * @param {(name:string)=>string|null} [deps.which]  — resolve a binary on PATH, or null
 * @returns {string|null} absolute path to a Chrome/Chromium, or null
 */
function findChrome(deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const existsSync = deps.existsSync || ((p) => { try { return fsReal.existsSync(p); } catch { return false; } });
  const which = deps.which || defaultWhich(platform);

  if (env.CHROME_PATH && existsSync(env.CHROME_PATH)) return env.CHROME_PATH;

  const abs = [...(CANDIDATES[platform] || [])];
  if (platform === 'win32' && env.LOCALAPPDATA) {
    abs.push(`${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`);
  }
  for (const p of abs) if (existsSync(p)) return p;

  for (const name of (PATH_NAMES[platform] || [])) {
    const resolved = which(name);
    if (resolved) return resolved;
  }
  return null;
}

function defaultWhich(platform) {
  const cmd = platform === 'win32' ? 'where' : 'which';
  return (name) => {
    try {
      const out = execFileSync(cmd, [name], { encoding: 'utf8' }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      return out[0] || null;
    } catch { return null; }
  };
}

module.exports = { findChrome, CANDIDATES };
