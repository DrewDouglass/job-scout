/**
 * linkedin.test.js — pure parsers + canary + Chrome locator for the LinkedIn source.
 * (The CDP ride-along driver itself drives a real Chrome and is bring-up-verified, not unit-tested.)
 * Run: node --test test/linkedin.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseVoyagerJobCards, jobIdFromUrn, workplaceFromUrns } = require('../src/sources/linkedin/voyager-parse');
const { parseGuestHtml } = require('../src/sources/linkedin/guest');
const { evaluateCanary } = require('../src/sources/linkedin/canary');
const { findChrome } = require('../src/sources/linkedin/chrome');

describe('voyager-parse', () => {
  const voyagerResponse = {
    data: { /* JobSearchCardsCollection wrapper — intentionally ignored */ },
    included: [
      { $type: 'com.linkedin.voyager.dash.organization.Company', entityUrn: 'urn:li:fsd_company:1441', name: 'Acme Corp' },
      { $type: 'com.linkedin.voyager.dash.jobs.JobPosting', entityUrn: 'urn:li:fsd_jobPosting:4012345678',
        title: 'Senior QA Engineer', formattedLocation: 'Austin, TX', listedAt: 1782000000000,
        workplaceTypes: ['urn:li:fsd_workplaceType:2'], companyDetails: { '*company': 'urn:li:fsd_company:1441' } },
      { $type: 'com.linkedin.voyager.dash.jobs.JobPostingCard', entityUrn: 'urn:li:fsd_jobPostingCard:4012345678' }, // IGNORE
    ],
  };

  it('extracts job id from a urn', () => {
    assert.equal(jobIdFromUrn('urn:li:fsd_jobPosting:4012345678'), '4012345678');
  });
  it('maps workplaceType urns (2=remote, 3=hybrid, 1=onsite)', () => {
    assert.deepEqual(workplaceFromUrns(['urn:li:fsd_workplaceType:2']), { workplaceTypes: ['Remote'], isRemote: true });
    assert.deepEqual(workplaceFromUrns(['urn:li:fsd_workplaceType:3']), { workplaceTypes: ['Hybrid'], isRemote: false });
  });
  it('parses included[] by $type, ignores JobPostingCard, resolves company via urn', () => {
    const jobs = parseVoyagerJobCards(voyagerResponse);
    assert.equal(jobs.length, 1);
    const j = jobs[0];
    assert.equal(j.guid, 'linkedin_4012345678');
    assert.equal(j.title, 'Senior QA Engineer');
    assert.equal(j.companyName, 'Acme Corp');         // resolved through companyDetails urn
    assert.equal(j.isRemote, true);
    assert.equal(j.detailsPageUrl, 'https://www.linkedin.com/jobs/view/4012345678');
    assert.equal(j.source, 'LinkedIn');
    assert.ok(j.postedDate.startsWith('2026-'));
  });
  it('dedupes the same job id across multiple captured responses', () => {
    const jobs = parseVoyagerJobCards([voyagerResponse, voyagerResponse]);
    assert.equal(jobs.length, 1);
  });
});

describe('guest html parse', () => {
  const html = `
  <li>
    <div class="base-card">
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/9988776655?refId=x">apply</a>
      <h3 class="base-search-card__title">Staff SDET (Remote)</h3>
      <h4 class="base-search-card__subtitle"><a href="#">Beta Inc</a></h4>
      <span class="job-search-card__location">Remote, United States</span>
      <time class="job-search-card__listdate" datetime="2026-06-24">3 days ago</time>
    </div>
  </li>
  <li>
    <div class="base-card">
      <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/1112223334">apply</a>
      <h3 class="base-search-card__title">QA Lead</h3>
      <h4 class="base-search-card__subtitle">Gamma LLC</h4>
      <span class="job-search-card__location">Denver, CO</span>
    </div>
  </li>`;

  it('parses base-cards into Adli\'s job shape', () => {
    const jobs = parseGuestHtml(html);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].guid, 'linkedin_9988776655');
    assert.equal(jobs[0].title, 'Staff SDET (Remote)');
    assert.equal(jobs[0].companyName, 'Beta Inc');
    assert.equal(jobs[0].isRemote, true);
    assert.equal(jobs[0].postedDate, '2026-06-24');
    assert.equal(jobs[1].companyName, 'Gamma LLC');
    assert.equal(jobs[1].isRemote, false);
    assert.equal(jobs[1].detailsPageUrl, 'https://www.linkedin.com/jobs/view/1112223334');
  });
  it('parses the CURRENT LinkedIn markup (slug-id href + data-entity-urn)', () => {
    // LinkedIn now ships /jobs/view/<slug>-<id>?<tracking> and the id in data-entity-urn.
    const current = `
    <li>
      <div class="base-card relative base-search-card" data-entity-urn="urn:li:jobPosting:4406118990">
        <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/software-engineer-new-grad-at-notion-4406118990?position=1&amp;pageNum=0&amp;refId=75jwj3dTPVAU&amp;trackingId=uhm4obU9">apply</a>
        <h3 class="base-search-card__title">Software Engineer, New Grad</h3>
        <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="#">Notion</a></h4>
        <span class="job-search-card__location">San Francisco, CA</span>
        <time class="job-search-card__listdate" datetime="2026-06-25">2 days ago</time>
      </div>
    </li>`;
    const jobs = parseGuestHtml(current);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].guid, 'linkedin_4406118990');           // id from data-entity-urn, not a broken /view/(\d+)
    assert.equal(jobs[0].title, 'Software Engineer, New Grad');
    assert.equal(jobs[0].companyName, 'Notion');
    assert.equal(jobs[0].detailsPageUrl, 'https://www.linkedin.com/jobs/view/4406118990');
  });
  it('returns [] for empty input', () => { assert.deepEqual(parseGuestHtml(''), []); });
});

describe('canary (never silent-empty)', () => {
  it('healthy when session alive + jobs parsed', () => {
    const c = evaluateCanary({ sessionAlive: true, httpStatuses: [200], matchedResponses: 2, parsedJobCount: 25 });
    assert.equal(c.ok, true); assert.equal(c.degraded, false);
  });
  it('session_expired on logged-out or 401/403', () => {
    assert.equal(evaluateCanary({ sessionAlive: false, httpStatuses: [], matchedResponses: 0, parsedJobCount: 0 }).reason, 'session_expired');
    assert.equal(evaluateCanary({ sessionAlive: true, httpStatuses: [403], matchedResponses: 1, parsedJobCount: 0 }).reason, 'session_expired');
  });
  it('no_job_response when nothing matched the job-cards pattern', () => {
    assert.equal(evaluateCanary({ sessionAlive: true, httpStatuses: [200], matchedResponses: 0, parsedJobCount: 0 }).reason, 'no_job_response');
  });
  it('shape_drift when matched a response but parsed 0 jobs', () => {
    assert.equal(evaluateCanary({ sessionAlive: true, httpStatuses: [200], matchedResponses: 2, parsedJobCount: 0 }).reason, 'shape_drift');
  });
});

describe('cross-OS Chrome locator', () => {
  it('honors $CHROME_PATH override', () => {
    const got = findChrome({ platform: 'linux', env: { CHROME_PATH: '/custom/chrome' }, existsSync: p => p === '/custom/chrome', which: () => null });
    assert.equal(got, '/custom/chrome');
  });
  it('finds the macOS app bundle', () => {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    assert.equal(findChrome({ platform: 'darwin', env: {}, existsSync: p => p === mac, which: () => null }), mac);
  });
  it('finds the Windows %LOCALAPPDATA% install', () => {
    const win = 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    const got = findChrome({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, existsSync: p => p === win, which: () => null });
    assert.equal(got, win);
  });
  it('falls back to PATH lookup on Linux', () => {
    const got = findChrome({ platform: 'linux', env: {}, existsSync: () => false, which: n => n === 'chromium' ? '/usr/bin/chromium' : null });
    assert.equal(got, '/usr/bin/chromium');
  });
  it('returns null when no Chrome anywhere', () => {
    assert.equal(findChrome({ platform: 'linux', env: {}, existsSync: () => false, which: () => null }), null);
  });
});
