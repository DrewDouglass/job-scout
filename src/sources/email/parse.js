/**
 * parse.js — PURE: turn a job-alert email (HTML) into Adli's job shape.
 *
 * Opt-in source. Job boards email alerts the user already subscribed to; we read those from the
 * user's OWN mailbox (Apple Mail local store, or IMAP) and extract the jobs. Best-effort + zero deps.
 * Reliable for LinkedIn (canonical comm/jobs/view/<id> links) and Indeed (jk=<id>); ZipRecruiter /
 * Glassdoor fall back to the apply URL. Company is best-effort (often only the title is cleanly present).
 */

function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ');
}

const GENERIC_LINK_TEXT = /^(view|apply|see|more|view job|apply now|see job|view details|unsubscribe|view all)\b/i;

/** Detect the board + a stable identity from a job link. Returns {source, guid, url} or null. */
function detectJob(href) {
  const u = decodeEntities(href);
  let m;
  if ((m = u.match(/linkedin\.com\/(?:comm\/)?jobs\/view\/(\d+)/i)))
    return { source: 'LinkedIn', guid: 'linkedin_' + m[1], url: `https://www.linkedin.com/jobs/view/${m[1]}` };
  if ((m = u.match(/indeed\.com\/[^\s"']*?[?&]jk=([a-z0-9]+)/i)) || (m = u.match(/indeed\.com\/viewjob[^\s"']*?jk=([a-z0-9]+)/i)))
    return { source: 'Indeed', guid: 'indeed_' + m[1], url: `https://www.indeed.com/viewjob?jk=${m[1]}` };
  if (/ziprecruiter\.com\/(?:jobs|job|c\/)/i.test(u)) {
    const clean = u.split(/[?#]/)[0];
    return { source: 'ZipRecruiter', guid: 'zr_' + clean.toLowerCase(), url: clean };
  }
  if (/glassdoor\.com\/(?:job-listing|partner\/jobListing)/i.test(u)) {
    const clean = u.split(/[?#]/)[0];
    return { source: 'Glassdoor', guid: 'gd_' + clean.toLowerCase(), url: clean };
  }
  return null;
}

/** Extract <a href>…text… anchors from an HTML body. */
function extractAnchors(html) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/ig;
  let m;
  while ((m = re.exec(html))) out.push({ href: m[1], text: decodeEntities(stripTags(m[2])) });
  return out;
}

/**
 * Parse one job-alert email into jobs.
 * @param {{from?:string, subject?:string, html?:string, receivedAt?:number}} email
 * @returns {object[]} jobs in Adli's shape (source-tagged, deduped by guid)
 */
function parseJobAlertEmail(email) {
  const html = email && email.html;
  if (!html) return [];
  const jobs = [];
  const seen = new Set();
  for (const a of extractAnchors(html)) {
    const det = detectJob(a.href);
    if (!det || seen.has(det.guid)) continue;
    const title = (a.text && !GENERIC_LINK_TEXT.test(a.text) && a.text.length > 3) ? a.text : '';
    if (!title) continue; // skip "View job" / icon links with no usable title
    seen.add(det.guid);
    jobs.push({
      guid: det.guid,
      title,
      companyName: '',                       // best-effort; usually only the title is cleanly linked
      jobLocation: { displayName: '' },
      postedDate: email.receivedAt ? new Date(email.receivedAt).toISOString() : null,
      salary: null,
      employmentType: '',
      detailsPageUrl: det.url,
      workplaceTypes: ['On-site'],
      isRemote: /remote/i.test(title),
      source: det.source,
      summary: '',
      viaEmail: true,
    });
  }
  return jobs;
}

/** Is this email plausibly a job alert? (sender/subject heuristic, to avoid scanning every message) */
function looksLikeJobAlert(email) {
  const from = String(email && email.from || '').toLowerCase();
  const subject = String(email && email.subject || '').toLowerCase();
  if (/jobalerts?-noreply@linkedin\.com|jobs-noreply@linkedin\.com|linkedin job alerts/.test(from)) return true;
  if (/@(indeed|ziprecruiter|glassdoor)\.com/.test(from)) return true;
  return /\bjob alert\b|new jobs? for|jobs? for your search|recommended jobs?|\bnew job\b/.test(subject);
}

module.exports = { parseJobAlertEmail, detectJob, extractAnchors, looksLikeJobAlert, stripTags, decodeEntities };
