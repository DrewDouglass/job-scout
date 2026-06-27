/**
 * tailor.test.js — resume tailoring: prompt, real .docx/.pdf rendering, end-to-end (mocked AI), errors.
 * Run: node --test test/tailor.test.js
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tailorResume, buildTailorPrompt, renderDocx, renderPdf } = require('../src/tailor');
const { JobScoutDB } = require('../src/db');

const tailored = {
  name: 'Drew Douglass', headline: 'Engineering Leader', contact: 'drew@example.com',
  summary: 'People-first engineering leader.',
  sections: [{ heading: 'Experience', bullets: ['Led platform team at Acme', 'Shipped X'] }],
};
const job = { title: 'Engineering Manager', companyName: 'Vercel', summary: 'Lead a platform team' };
const baseResume = 'Drew Douglass\nEngineering leader, 10 years. Led teams at Acme. Skills: hiring, platform.';

describe('buildTailorPrompt', () => {
  it('embeds the never-fabricate rule, the job, and the base resume', () => {
    const p = buildTailorPrompt(job, baseResume, 'never claim a title I did not hold');
    assert.ok(/do NOT invent/i.test(p));
    assert.ok(p.includes('Engineering Manager'));
    assert.ok(p.includes('Led teams at Acme'));
    assert.ok(p.includes('never claim a title')); // skills profile woven in
  });
});

describe('renderers produce real files', () => {
  it('renderDocx returns a valid .docx (zip magic PK)', async () => {
    const buf = await renderDocx(tailored);
    assert.ok(buf.length > 500);
    assert.equal(buf[0], 0x50); assert.equal(buf[1], 0x4b); // "PK"
  });
  it('renderPdf returns a valid .pdf (%PDF header)', async () => {
    const buf = await renderPdf(tailored);
    assert.ok(buf.length > 500);
    assert.equal(buf.slice(0, 5).toString(), '%PDF-');
  });
});

describe('tailorResume end-to-end (mocked AI)', () => {
  let tmp, db;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobscout-tailor-')); db = new JobScoutDB(path.join(tmp, 't.db')); });
  afterEach(() => { try { db.close(); } catch {} fs.rmSync(tmp, { recursive: true, force: true }); });

  it('tailors, writes .docx + .pdf, and registers the resume', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(tailored) }] }) });
    const res = await tailorResume(db, {
      job, baseResumeText: baseResume,
      settings: { scoreProvider: 'haiku', candidateName: 'Drew Douglass', anthropicKey: 'K' },
      opts: { outDir: path.join(tmp, 'resumes'), fetchImpl },
    });
    assert.ok(res.docxFile.endsWith('.docx'));
    assert.ok(res.pdfFile.endsWith('.pdf'));
    // files actually exist with valid magic
    const docxBuf = fs.readFileSync(path.join(res.dir, res.docxFile));
    const pdfBuf = fs.readFileSync(path.join(res.dir, res.pdfFile));
    assert.equal(docxBuf.slice(0, 2).toString(), 'PK');
    assert.equal(pdfBuf.slice(0, 5).toString(), '%PDF-');
    // registered in the library
    const reg = db.getResumes().find(r => r.id === res.resumeId);
    assert.equal(reg.type, 'tailored');
    assert.equal(reg.company, 'Vercel');
  });

  it('throws no_base_resume when the base resume is empty', async () => {
    await assert.rejects(() => tailorResume(db, { job, baseResumeText: '', settings: { scoreProvider: 'haiku' } }), /no_base_resume/);
  });

  it('throws needs_ai_provider when scoring is keyword (no LLM)', async () => {
    await assert.rejects(() => tailorResume(db, { job, baseResumeText: baseResume, settings: { scoreProvider: 'keyword' } }), /needs_ai_provider/);
  });
});
