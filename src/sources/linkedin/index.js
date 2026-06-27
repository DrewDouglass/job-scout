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

  // Ride-along off → guest baseline (account-safe default).
  const g = await guest();
  return { jobs: g.jobs, canary: null, source: guestEnabled ? 'guest' : 'none', error: g.error };
}

module.exports = { searchLinkedIn };
