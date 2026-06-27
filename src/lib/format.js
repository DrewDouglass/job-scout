/**
 * format.js — Pure string / display / date utilities.
 *
 * Ported VERBATIM from Adli Waziri's cowork-job-scout (test/utils.js), which
 * extracted them from his dashboard.html. Behaviour is unchanged so his test
 * suite (test/utils.test.js) stays green against the re-platformed code.
 */

function normalizeForMatch(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scoreClass(s) {
  if (s >= 9) return 's9';
  if (s >= 8) return 's8';
  if (s >= 7) return 's7';
  if (s >= 6) return 's6';
  return 's5';
}

function sourceBadgeClass(src) {
  if (!src) return 'b-other';
  const s = src.toLowerCase();
  if (s === 'dice')         return 'b-dice';
  if (s === 'indeed')       return 'b-indeed';
  if (s === 'ziprecruiter') return 'b-ziprecruiter';
  if (s === 'linkedin')     return 'b-linkedin';
  if (s === 'glassdoor')    return 'b-glassdoor';
  if (s === 'jsearch')      return 'b-jsearch';
  return 'b-other';
}

function typeInfo(types, isRemote) {
  const t = (types || []).join('').toLowerCase();
  if (isRemote || t.includes('remote')) return { label: 'Remote', cls: 't-remote' };
  if (t.includes('hybrid'))             return { label: 'Hybrid', cls: 't-hybrid' };
  return { label: 'On-Site', cls: 't-onsite' };
}

/**
 * formatDate — relative date from a date string.
 * Accepts optional `now` (ms timestamp) for deterministic testing.
 */
function formatDate(str, now = Date.now()) {
  if (!str) return '—';
  const d = new Date(str);
  if (isNaN(d)) return str.replace(/^\w+ /, '').replace(/, \d{4}$/, '');
  const diff = Math.floor((now - d) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? '1d ago' : diff + 'd ago';
}

function fmtShortDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * getWeekBounds — start/end of the week at a given offset from current week.
 * Accepts optional `now` Date for deterministic testing.
 */
function getWeekBounds(offset, now = new Date()) {
  const day = now.getDay();
  const sunday = new Date(now);
  sunday.setDate(now.getDate() - day + offset * 7);
  sunday.setHours(0, 0, 0, 0);
  const saturday = new Date(sunday);
  saturday.setDate(sunday.getDate() + 6);
  saturday.setHours(23, 59, 59, 999);
  return { start: sunday, end: saturday };
}

module.exports = {
  normalizeForMatch,
  esc,
  scoreClass,
  sourceBadgeClass,
  typeInfo,
  formatDate,
  fmtShortDate,
  getWeekBounds,
};
