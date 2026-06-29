/**
 * guest.js — LinkedIn's UNAUTHENTICATED guest jobs endpoint (no login, account-safe).
 *
 * This is the zero-setup LinkedIn source: it needs no Chrome, no login, no cookie, and
 * touches the user's real LinkedIn account zero times. It returns lower-fidelity HTML
 * cards, so it is the BASELINE / graceful-degradation LinkedIn feed (the authenticated
 * ride-along is richer when the user has connected it). Best-effort: paced + degrades to [].
 *
 * Endpoint: https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search
 * Zero npm deps — Node global fetch + a small tolerant HTML scan.
 */

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
}
function firstMatch(block, re) { const m = block.match(re); return m ? decodeEntities(stripTags(m[1])) : ''; }

/** PURE: parse the guest endpoint HTML fragment into Adli's job shape (tolerant, class-substring based). */
function parseGuestHtml(html) {
  if (!html) return [];
  const jobs = [];
  const seen = new Set();
  // Each result is an <li> ... </li> containing a base-card. Split tolerantly on <li boundaries.
  const blocks = String(html).split(/<li[ >]/i).slice(1);
  for (const block of blocks) {
    // Job id: prefer the stable data-entity-urn; else the trailing numeric id in the jobs/view PATH.
    // LinkedIn changed guest links from /jobs/view/<id> to /jobs/view/<slug>-<id>?<tracking>, which
    // broke the old `/jobs/view/(\d+)` match. data-entity-urn is the durable anchor.
    const urn = (block.match(/data-entity-urn="urn:li:job[Pp]osting:(\d+)"/i) || [])[1];
    let hrefId = null;
    const href = (block.match(/href="([^"]*\/jobs\/view\/[^"]+)"/i) || [])[1] || '';
    if (href) { const ids = href.split('?')[0].match(/\d{6,}/g); if (ids) hrefId = ids[ids.length - 1]; }
    const id = urn || hrefId || null;
    if (!id || seen.has(id)) continue;
    const title = firstMatch(block, /class="[^"]*_title[^"]*"[^>]*>([\s\S]*?)<\//i);
    const company = firstMatch(block, /class="[^"]*_subtitle[^"]*"[^>]*>([\s\S]*?)<\/(?:h4|div|a|span)>/i);
    const location = firstMatch(block, /class="[^"]*_location[^"]*"[^>]*>([\s\S]*?)<\//i);
    const datetime = (block.match(/datetime="([^"]+)"/i) || [])[1] || '';
    if (!title) continue;
    seen.add(id);
    const isHybrid = /\bhybrid\b/i.test(location);
    const isRemote = !isHybrid && /remote/i.test(location);
    jobs.push({
      guid: 'linkedin_' + id,
      title,
      companyName: company,
      jobLocation: { displayName: location },
      postedDate: datetime || null,
      salary: null,
      employmentType: '',
      detailsPageUrl: `https://www.linkedin.com/jobs/view/${id}`,
      workplaceTypes: isRemote ? ['Remote'] : isHybrid ? ['Hybrid'] : ['On-site'],
      isRemote,
      source: 'LinkedIn',
      summary: '',
    });
  }
  return jobs;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch LinkedIn guest job cards for the configured searches.
 * @param {object} settings
 * @param {object} opts {pages?, pauseMs?, fetchImpl?, onStatus?, sleepImpl?}
 * @returns {Promise<{jobs:object[], error:string|null}>}
 */
async function searchLinkedInGuest(settings, opts = {}) {
  const doFetch = opts.fetchImpl || fetch;
  const doSleep = opts.sleepImpl || sleep;
  const pages = Math.min(Math.max(opts.pages || 1, 1), 5);
  const pauseMs = opts.pauseMs == null ? 2500 : opts.pauseMs;   // be polite: 2-3s between requests
  const terms = (settings.searchTerms && settings.searchTerms.length) ? settings.searchTerms : ['software engineer'];
  const location = (settings.location || '').trim();
  const out = [];
  const seen = new Set();
  let error = null;
  let firstReq = true;
  let okResponses = 0;   // # of real (200, non-trivial) pages we got back
  let parsedCount = 0;   // # of cards parsed across them — okResponses>0 && parsedCount===0 means shape drift

  for (const term of terms) {
    for (let page = 0; page < pages; page++) {
      if (!firstReq) await doSleep(pauseMs);
      firstReq = false;
      if (opts.onStatus) opts.onStatus(`LinkedIn guest: "${term}" page ${page + 1}`);
      const params = new URLSearchParams({ keywords: term, location: location || 'United States', start: String(page * 25) });
      try {
        const res = await doFetch(`${BASE}?${params.toString()}`, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
        });
        if (!res.ok) { error = `http_${res.status}`; if (res.status === 429) return { jobs: out, error, okResponses, parsedCount }; continue; }
        const html = await res.text();
        if (html && html.length > 500) okResponses++;     // a real page came back (not empty/blocked)
        const parsed = parseGuestHtml(html);
        parsedCount += parsed.length;
        if (!parsed.length) break; // no cards on this page → stop paging this term
        for (const j of parsed) if (!seen.has(j.guid)) { seen.add(j.guid); out.push(j); }
      } catch (e) { error = String(e && e.message || e); }
    }
  }
  return { jobs: out, error: out.length ? null : error, okResponses, parsedCount };
}

module.exports = { searchLinkedInGuest, parseGuestHtml };
