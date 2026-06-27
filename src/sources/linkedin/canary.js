/**
 * canary.js — the LOUD canary for the LinkedIn ride-along (canon, never silent-empty).
 *
 * project_shani_linkedin_ridealong_answer_2026_06_18: the ride-along is the highest-
 * maintenance source (LinkedIn reshapes ~weekly). The NON-NEGOTIABLE mitigation is that
 * any failure surfaces to the user immediately — never "quietly captured nothing". This
 * pure function turns a capture outcome into a user-facing status so the daily run and
 * dashboard can show it. The tool never goes dark: on any degrade, the JSearch + guest
 * baseline still carries the run.
 *
 * @param {object} o
 * @param {boolean} o.sessionAlive       — li_at cookie valid (from CDP getCookies)
 * @param {number[]} o.httpStatuses      — statuses seen on job-cards responses
 * @param {number} o.matchedResponses    — # responses whose URL matched the job-cards pattern
 * @param {number} o.parsedJobCount      — # jobs parsed out of the captured responses
 * @returns {{ok:boolean, degraded:boolean, reason:string|null, message:string}}
 */
function evaluateCanary(o) {
  const statuses = o.httpStatuses || [];
  const blocked = statuses.some(s => s === 401 || s === 403);

  if (!o.sessionAlive || blocked) {
    return degraded('session_expired',
      'LinkedIn session expired or was challenged. Re-run `job-scout linkedin login` to reconnect. (JSearch + guest results are unaffected.)');
  }
  if ((o.matchedResponses || 0) === 0) {
    return degraded('no_job_response',
      'LinkedIn returned no recognizable job-cards response — LinkedIn may have changed its jobs page. Using the guest feed for now; check for a job-scout update.');
  }
  if ((o.parsedJobCount || 0) === 0) {
    return degraded('shape_drift',
      'Captured a LinkedIn job-cards response but parsed 0 jobs — likely a shape change. Using the guest feed for now; check for a job-scout update.');
  }
  return { ok: true, degraded: false, reason: null, message: `LinkedIn ride-along healthy (${o.parsedJobCount} jobs).` };
}

function degraded(reason, message) { return { ok: false, degraded: true, reason, message }; }

module.exports = { evaluateCanary };
