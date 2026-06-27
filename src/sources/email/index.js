/**
 * index.js — email-source orchestrator (opt-in; OFF by default).
 *
 * Job boards email alerts the user already subscribed to. With consent, we read those from the
 * user's OWN mailbox — the Apple Mail local store (macOS, zero deps) and/or IMAP (Gmail/iCloud/
 * Outlook via an app password) — and feed the parsed jobs into the same dedup + scoring pipeline.
 * Both readers are injectable so the orchestration is testable offline.
 */

const { scanAppleMail } = require('./emlx');
const { scanImap } = require('./imap');

async function searchEmail(settings, opts = {}) {
  const src = (settings && settings.sources) || {};
  const all = [];
  const errors = [];

  // Each reader is isolated: a thrown reader becomes a logged error, never aborts the wider multi-source run.
  if (src.appleMail) {
    try {
      const r = await (opts.appleMailImpl || scanAppleMail)(settings, opts);
      all.push(...(r.jobs || []));
      if (r.error) errors.push('applemail:' + r.error);
    } catch (e) { errors.push('applemail:' + String(e && e.message || e)); }
  }
  if (src.imap) {
    try {
      const r = await (opts.imapImpl || scanImap)(settings, opts);
      all.push(...(r.jobs || []));
      if (r.error) errors.push('imap:' + r.error);
    } catch (e) { errors.push('imap:' + String(e && e.message || e)); }
  }
  return { jobs: all, errors };
}

module.exports = { searchEmail };
