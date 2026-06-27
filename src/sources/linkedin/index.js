/**
 * index.js — LinkedIn source orchestrator.
 *
 * Priority (per the documented canon): the authenticated ride-along is the richest LinkedIn
 * feed when the user has connected it; on ANY canary degrade it falls through to the
 * account-safe guest baseline so the tool never goes dark. The guest endpoint is also the
 * zero-setup default for users who don't connect LinkedIn. The canary is always surfaced.
 */

const { parseVoyagerJobCards } = require('./voyager-parse');
const { evaluateCanary } = require('./canary');
const { searchLinkedInGuest } = require('./guest');

const DEAD_CANARY = () => evaluateCanary({ sessionAlive: false, httpStatuses: [], matchedResponses: 0, parsedJobCount: 0 });

/**
 * Canary for the no-login guest feed. Returns null when healthy (the contract: null = nothing to
 * surface) and a loud degraded status when the feed is reachable-but-unreadable (LinkedIn changed
 * its markup) or unreachable — so the guest path is never silently empty either.
 */
function guestCanary(g) {
  if ((g.jobs || []).length > 0) return null;                       // healthy → no problem to raise
  if ((g.okResponses || 0) > 0 && (g.parsedCount || 0) === 0) {
    return { ok: false, degraded: true, reason: 'guest_shape_drift',
      message: "LinkedIn's public job feed returned pages but no readable jobs — LinkedIn likely changed its markup. Check for a job-scout update. (JSearch results are unaffected.)" };
  }
  if (g.error) {
    return { ok: false, degraded: true, reason: 'guest_unreachable',
      message: "Couldn't reach LinkedIn's public job feed right now (network or rate limit). It will retry next run. (JSearch results are unaffected.)" };
  }
  return null;   // genuinely no results (or a caller without meta) → don't fabricate an alarm
}

/**
 * @param {object} settings
 * @param {object} opts
 *   opts.launchImpl(opts)         -> ensure the dedicated headless Chrome (default: observer.launchChrome)
 *   opts.captureImpl(urls, opts)  -> {captures,statuses,matchedResponses,sessionAlive} (default: observer.captureSavedSearches)
 *   opts.guestImpl(settings,opts) -> {jobs,error} (default: searchLinkedInGuest)
 * @returns {Promise<{jobs:object[], canary:object|null, source:string, error:string|null}>}
 */
async function searchLinkedIn(settings, opts = {}) {
  const sources = settings.sources || {};
  const urls = settings.linkedinSearchUrls || [];
  const guestImpl = opts.guestImpl || searchLinkedInGuest;
  const guestEnabled = sources.linkedinGuest !== false;

  const guest = async () => (guestEnabled ? await guestImpl(settings, opts) : { jobs: [], error: null });

  if (sources.linkedinRideAlong && urls.length) {
    // Lazy-require the heavy driver only when the ride-along is actually used.
    const observer = opts._observer || require('./observer');
    const launchImpl = opts.launchImpl || observer.launchChrome;
    const captureImpl = opts.captureImpl || observer.captureSavedSearches;
    try {
      await launchImpl({ headless: true });
      const cap = await captureImpl(urls, opts);
      const jobs = parseVoyagerJobCards(cap.captures);
      const canary = evaluateCanary({
        sessionAlive: cap.sessionAlive, httpStatuses: cap.statuses,
        matchedResponses: cap.matchedResponses, parsedJobCount: jobs.length,
      });
      if (canary.ok) return { jobs, canary, source: 'ride-along', error: null };
      const g = await guest();                       // degraded → keep the canary, carry the run on guest
      return { jobs: g.jobs, canary, source: 'guest-fallback', error: g.error };
    } catch (e) {
      const g = await guest();
      return { jobs: g.jobs, canary: DEAD_CANARY(), source: 'guest-fallback', error: g.error || String(e && e.message || e) };
    }
  }

  // Ride-along off → guest baseline (account-safe default). Surface a loud canary if the guest
  // feed is reachable-but-unreadable or unreachable, so this path is never silently empty.
  const g = await guest();
  return { jobs: g.jobs, canary: guestEnabled ? guestCanary(g) : null, source: guestEnabled ? 'guest' : 'none', error: g.error };
}

module.exports = { searchLinkedIn };
