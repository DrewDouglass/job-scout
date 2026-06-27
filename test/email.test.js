/**
 * email.test.js — job-alert parsing, MIME extraction, .emlx, and the email orchestrator.
 * Run: node --test test/email.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseJobAlertEmail, detectJob, looksLikeJobAlert } = require('../src/sources/email/parse');
const { extractHtml, parseMessage } = require('../src/sources/email/mime');
const { parseEmlx } = require('../src/sources/email/emlx');
const { searchEmail } = require('../src/sources/email');

describe('parse — detectJob', () => {
  it('LinkedIn comm/jobs/view → canonical id + url', () => {
    assert.deepEqual(detectJob('https://www.linkedin.com/comm/jobs/view/4012345678?trk=x'),
      { source: 'LinkedIn', guid: 'linkedin_4012345678', url: 'https://www.linkedin.com/jobs/view/4012345678' });
  });
  it('Indeed jk= → id + viewjob url', () => {
    const d = detectJob('https://www.indeed.com/rc/clk?jk=abc123def&from=alert');
    assert.equal(d.source, 'Indeed'); assert.equal(d.guid, 'indeed_abc123def');
  });
  it('ZipRecruiter + Glassdoor fall back to the clean url', () => {
    assert.equal(detectJob('https://www.ziprecruiter.com/jobs/acme-123?tsid=x').source, 'ZipRecruiter');
    assert.equal(detectJob('https://www.glassdoor.com/job-listing/qa-acme-JV_123.htm').source, 'Glassdoor');
  });
  it('non-job links → null', () => {
    assert.equal(detectJob('https://www.linkedin.com/unsubscribe'), null);
  });
});

describe('parse — parseJobAlertEmail', () => {
  const html = `
    <a href="https://www.linkedin.com/comm/jobs/view/4012345678?trk=x">Senior Engineering Manager</a>
    <a href="https://www.linkedin.com/comm/jobs/view/4012345679">Staff Engineer (Remote)</a>
    <a href="https://www.linkedin.com/comm/jobs/view/4012345680">View job</a>
    <a href="https://www.indeed.com/rc/clk?jk=zz99">QA Lead</a>`;
  it('extracts titled jobs, skips generic "View job" links, dedupes', () => {
    const jobs = parseJobAlertEmail({ from: 'jobalerts-noreply@linkedin.com', subject: 'job alert', html, receivedAt: 1782000000000 });
    const guids = jobs.map(j => j.guid);
    assert.ok(guids.includes('linkedin_4012345678'));
    assert.ok(guids.includes('linkedin_4012345679'));
    assert.ok(guids.includes('indeed_zz99'));
    assert.ok(!guids.includes('linkedin_4012345680')); // "View job" has no usable title
    const sem = jobs.find(j => j.guid === 'linkedin_4012345678');
    assert.equal(sem.title, 'Senior Engineering Manager');
    assert.equal(sem.source, 'LinkedIn');
    assert.equal(sem.viaEmail, true);
    assert.equal(jobs.find(j => j.guid === 'linkedin_4012345679').isRemote, true);
  });
  it('returns [] for empty html', () => { assert.deepEqual(parseJobAlertEmail({ html: '' }), []); });
});

describe('parse — looksLikeJobAlert', () => {
  it('recognizes LinkedIn/Indeed senders and job-alert subjects', () => {
    assert.ok(looksLikeJobAlert({ from: 'LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>' }));
    assert.ok(looksLikeJobAlert({ from: 'x@indeed.com' }));
    assert.ok(looksLikeJobAlert({ subject: '5 new jobs for "engineering manager"' }));
    assert.ok(!looksLikeJobAlert({ from: 'mom@example.com', subject: 'dinner sunday?' }));
  });
});

describe('mime — extractHtml', () => {
  const raw = [
    'Content-Type: multipart/alternative; boundary="BOUND"',
    '',
    '--BOUND',
    'Content-Type: text/plain',
    '',
    'plain text version',
    '--BOUND',
    'Content-Type: text/html',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<a href=3D"https://www.linkedin.com/jobs/view/999">Job=20Title</a>',
    '--BOUND--',
  ].join('\r\n');
  it('pulls the text/html part and decodes quoted-printable', () => {
    const html = extractHtml(raw);
    assert.ok(html.includes('https://www.linkedin.com/jobs/view/999'));
    assert.ok(html.includes('Job Title')); // =20 decoded to space, =3D to =
  });
  it('parseMessage returns headers + html', () => {
    const { headers, html } = parseMessage('From: a@b.com\r\nSubject: hi\r\nContent-Type: text/html\r\n\r\n<b>x</b>');
    assert.equal(headers.from, 'a@b.com');
    assert.ok(html.includes('<b>x</b>'));
  });
  it('decodes utf-8 accents in quoted-printable (no mojibake)', () => {
    // =C3=A9 is "é" in UTF-8; must round-trip, not become two garbage chars.
    const raw = 'Content-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<a>Caf=C3=A9 Manager</a>';
    assert.ok(extractHtml(raw).includes('Café Manager'));
  });
  it('decodes a base64 html part with a declared charset', () => {
    const b64 = Buffer.from('<a>Señor Dev</a>', 'utf8').toString('base64');
    const raw = 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64;
    assert.ok(extractHtml(raw).includes('Señor Dev'));
  });
  it('does not mis-split when a body line merely contains the boundary token (M4)', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="BB"', '',
      '--BB', 'Content-Type: text/html', '',
      '<pre>run with --BB to enable</pre><a href="https://www.indeed.com/rc/clk?jk=keep1">Keep Me</a>',
      '--BB--',
    ].join('\r\n');
    const html = extractHtml(raw);
    assert.ok(html.includes('jk=keep1'), 'job link survived the in-body boundary token');
  });
});

describe('emlx — parseEmlx', () => {
  it('strips the byte-count line and parses the embedded message', () => {
    const msg = 'From: jobalerts-noreply@linkedin.com\r\nSubject: Job alert\r\nContent-Type: text/html\r\n\r\n<a href="https://www.linkedin.com/jobs/view/77">Role</a>';
    const buf = Buffer.from(Buffer.byteLength(msg) + '\n' + msg + '\n<?xml version="1.0"?><plist></plist>');
    const { headers, html } = parseEmlx(buf);
    assert.equal(headers.from, 'jobalerts-noreply@linkedin.com');
    assert.ok(html.includes('/jobs/view/77'));
    assert.ok(!html.includes('<plist')); // byte-count slice excluded the trailing plist
  });
});

describe('orchestrator — searchEmail', () => {
  it('runs only enabled readers and merges + labels errors', async () => {
    const settings = { sources: { appleMail: true, imap: true } };
    const r = await searchEmail(settings, {
      appleMailImpl: async () => ({ jobs: [{ guid: 'linkedin_1', source: 'LinkedIn' }], error: null }),
      imapImpl: async () => ({ jobs: [], error: 'imap_not_configured' }),
    });
    assert.equal(r.jobs.length, 1);
    assert.ok(r.errors.includes('imap:imap_not_configured'));
  });
  it('runs nothing when both are off', async () => {
    const r = await searchEmail({ sources: { appleMail: false, imap: false } }, {
      appleMailImpl: async () => { throw new Error('should not run'); },
    });
    assert.equal(r.jobs.length, 0);
  });
  it('isolates a THROWING reader — never aborts the run, logs it as an error (H2)', async () => {
    const r = await searchEmail({ sources: { appleMail: true, imap: true } }, {
      appleMailImpl: async () => { throw new Error('FDA prompt exploded'); },
      imapImpl: async () => ({ jobs: [{ guid: 'linkedin_9', source: 'LinkedIn' }], error: null }),
    });
    assert.equal(r.jobs.length, 1, 'imap jobs survived the apple-mail throw');
    assert.ok(r.errors.some(e => e.startsWith('applemail:') && /exploded/.test(e)));
  });
});
