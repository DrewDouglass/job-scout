/**
 * linkedin-orchestrator.test.js — searchLinkedIn() priority + graceful fall-through.
 * Run: node --test test/linkedin-orchestrator.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { searchLinkedIn } = require('../src/sources/linkedin');

// A captured Voyager response carrying one JobPosting.
const voyagerCapture = {
  included: [
    { $type: 'com.linkedin.voyager.dash.jobs.JobPosting', entityUrn: 'urn:li:fsd_jobPosting:5550001',
      title: 'SDET', formattedLocation: 'Remote', listedAt: 1782000000000,
      workplaceTypes: ['urn:li:fsd_workplaceType:2'], companyName: 'Acme' },
  ],
};
const guestJob = { guid: 'linkedin_777', title: 'QA Lead', companyName: 'Beta', jobLocation: { displayName: 'Denver' }, source: 'LinkedIn' };

const baseSettings = (over) => ({ sources: { linkedinRideAlong: true, linkedinGuest: true }, linkedinSearchUrls: ['https://x/jobs/search'], ...over });

describe('searchLinkedIn orchestration', () => {
  it('uses the ride-along when healthy', async () => {
    const r = await searchLinkedIn(baseSettings(), {
      launchImpl: async () => ({}),
      captureImpl: async () => ({ captures: [voyagerCapture], statuses: [200], matchedResponses: 1, sessionAlive: true }),
      guestImpl: async () => { throw new Error('guest should not be called'); },
    });
    assert.equal(r.source, 'ride-along');
    assert.equal(r.jobs.length, 1);
    assert.equal(r.jobs[0].guid, 'linkedin_5550001');
    assert.equal(r.canary.ok, true);
  });

  it('falls through to guest (carrying the canary) when the session is dead', async () => {
    const r = await searchLinkedIn(baseSettings(), {
      launchImpl: async () => ({}),
      captureImpl: async () => ({ captures: [], statuses: [], matchedResponses: 0, sessionAlive: false }),
      guestImpl: async () => ({ jobs: [guestJob], error: null }),
    });
    assert.equal(r.source, 'guest-fallback');
    assert.equal(r.jobs[0].guid, 'linkedin_777');
    assert.equal(r.canary.reason, 'session_expired');  // surfaced, never silent
  });

  it('falls through to guest when the driver throws (Chrome missing, etc.)', async () => {
    const r = await searchLinkedIn(baseSettings(), {
      launchImpl: async () => { throw new Error('Chrome not found'); },
      guestImpl: async () => ({ jobs: [guestJob], error: null }),
    });
    assert.equal(r.source, 'guest-fallback');
    assert.equal(r.jobs.length, 1);
    assert.equal(r.canary.degraded, true);
  });

  it('uses guest baseline when ride-along is off', async () => {
    const r = await searchLinkedIn(baseSettings({ sources: { linkedinRideAlong: false, linkedinGuest: true } }), {
      guestImpl: async () => ({ jobs: [guestJob], error: null }),
    });
    assert.equal(r.source, 'guest');
    assert.equal(r.canary, null);
    assert.equal(r.jobs.length, 1);
  });

  it('returns nothing when both LinkedIn sources are off', async () => {
    const r = await searchLinkedIn(baseSettings({ sources: { linkedinRideAlong: false, linkedinGuest: false } }), {});
    assert.equal(r.source, 'none');
    assert.equal(r.jobs.length, 0);
  });
});
