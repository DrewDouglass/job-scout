/**
 * imap.js — read job-alert emails over IMAP (Gmail / iCloud / Outlook), opt-in.
 *
 * Works for any IMAP mailbox with an app password (the portable, no-OAuth path — Gmail/iCloud/Outlook
 * all support app passwords). Fetches recent INBOX messages, keeps the job alerts, parses them into
 * jobs. The ImapFlow client is injectable so the scan logic is testable without a live server.
 */

const { parseMessage } = require('./mime');
const { parseJobAlertEmail, looksLikeJobAlert } = require('./parse');

const PRESETS = {
  gmail: { host: 'imap.gmail.com', port: 993, secure: true },
  icloud: { host: 'imap.mail.me.com', port: 993, secure: true },
  outlook: { host: 'outlook.office365.com', port: 993, secure: true },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
};

/**
 * @param {object} settings — uses settings.imap = { provider, host, port, user, appPassword }
 * @param {object} opts — { days, ImapFlow (inject) }
 * @returns {Promise<{jobs:object[], error:string|null}>}
 */
async function scanImap(settings, opts = {}) {
  const cfg = (settings && settings.imap) || {};
  const preset = PRESETS[(cfg.provider || 'gmail')] || {};
  const host = cfg.host || preset.host;
  const user = cfg.user;
  const pass = cfg.appPassword || cfg.pass;
  if (!host || !user || !pass) return { jobs: [], error: 'imap_not_configured' };

  const ImapFlow = opts.ImapFlow || (() => require('imapflow').ImapFlow)();
  const client = new ImapFlow({
    host, port: cfg.port || preset.port || 993, secure: cfg.secure !== false,
    auth: { user, pass }, logger: false,
  });
  const days = opts.days || 14;
  const all = [];
  const seen = new Set();
  let error = null;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - days * 86400000);
      for await (const msg of client.fetch({ since }, { envelope: true, source: true })) {
        // One malformed message must never abort the whole scan — isolate per-message (mirrors emlx.js).
        try {
          const raw = msg.source ? (Buffer.isBuffer(msg.source) ? msg.source.toString('utf8') : String(msg.source)) : '';
          const env = msg.envelope || {};
          const from = (env.from && env.from[0]) ? (env.from[0].address || '') : '';
          const date = env.date ? (env.date instanceof Date ? env.date.getTime() : Date.parse(env.date)) : null;
          const email = { from, subject: env.subject || '', html: parseMessage(raw).html, receivedAt: date };
          if (!looksLikeJobAlert(email)) continue;
          for (const j of parseJobAlertEmail(email)) if (!seen.has(j.guid)) { seen.add(j.guid); all.push(j); }
        } catch { continue; }
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    error = String(e && e.message || e);
    try { await client.logout(); } catch {}
  }
  return { jobs: all, error: all.length ? null : error };
}

module.exports = { scanImap, PRESETS };
