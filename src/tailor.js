/**
 * tailor.js — end-to-end resume tailoring (no copy-paste; the gap Adli's Cowork artifact couldn't close).
 *
 * Reads the user's base resume (plain text), asks their configured AI provider (Haiku or Ollama) to
 * tailor it for a specific job — TRUTHFULLY, never inventing experience — and writes a real `.docx`
 * and `.pdf`, then registers the result in the resume library. Pure renderers (testable); the AI call
 * is injectable.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
const PDFDocument = require('pdfkit');
const { generateJSON } = require('./scoring/ai');

const TAILOR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'summary', 'sections'],
  properties: {
    name: { type: 'string' }, headline: { type: 'string' }, contact: { type: 'string' }, summary: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['heading', 'bullets'],
        properties: { heading: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } },
      },
    },
  },
};

function homeDir() { return process.env.JOB_SCOUT_HOME || path.join(os.homedir(), '.job-scout'); }

/** PURE: the tailoring prompt. Hard rule: use ONLY facts in the base resume; never fabricate. */
function buildTailorPrompt(job, baseResumeText, skillsProfile = '') {
  return `Tailor this resume for the job below. Use ONLY facts present in the base resume — do NOT invent experience, job titles, skills, dates, employers, or metrics. Reorder and reword to surface the most relevant experience, and weave in the job's keywords naturally ONLY where they truthfully apply.${skillsProfile ? '\n\nStanding rules from the candidate (honor these):\n' + skillsProfile : ''}

JOB
Title: ${job.title || ''}
Company: ${job.companyName || ''}
${job.summary ? 'Description: ' + String(job.summary).slice(0, 1500) : ''}

BASE RESUME
${baseResumeText}

Return JSON: { name, headline, contact, summary, sections:[{heading, bullets:[...]}] }. Truthful, concise, well-ordered for this role.`;
}

/** PURE: render the tailored structure into a .docx Buffer. */
async function renderDocx(r) {
  const children = [];
  children.push(new Paragraph({ text: r.name || 'Resume', heading: HeadingLevel.TITLE }));
  if (r.headline) children.push(new Paragraph({ children: [new TextRun({ text: r.headline, italics: true })] }));
  if (r.contact) children.push(new Paragraph({ text: r.contact }));
  if (r.summary) {
    children.push(new Paragraph({ text: 'Summary', heading: HeadingLevel.HEADING_2 }));
    children.push(new Paragraph({ text: r.summary }));
  }
  for (const s of (r.sections || [])) {
    children.push(new Paragraph({ text: s.heading || '', heading: HeadingLevel.HEADING_2 }));
    for (const b of (s.bullets || [])) children.push(new Paragraph({ text: b, bullet: { level: 0 } }));
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

/** PURE: render the tailored structure into a .pdf Buffer (pdfkit ships Helvetica — no font files needed). */
function renderPdf(r) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(20).fillColor('#111').text(r.name || 'Resume');
    if (r.headline) doc.fontSize(11).fillColor('#555').text(r.headline);
    if (r.contact) doc.fontSize(10).fillColor('#555').text(r.contact);
    doc.moveDown(0.6).fillColor('#111');
    if (r.summary) { doc.fontSize(13).text('Summary'); doc.moveDown(0.2).fontSize(10).fillColor('#333').text(r.summary); doc.moveDown(0.5).fillColor('#111'); }
    for (const s of (r.sections || [])) {
      doc.fontSize(13).fillColor('#111').text(s.heading || '');
      doc.moveDown(0.2).fontSize(10).fillColor('#333');
      for (const b of (s.bullets || [])) doc.text('•  ' + b, { indent: 10 });
      doc.moveDown(0.5);
    }
    doc.end();
  });
}

function sanitize(s) { return String(s || '').replace(/[^a-zA-Z0-9]/g, ''); }

/**
 * Tailor a base resume for `job`, write .docx + .pdf, register in the resume library.
 * @returns {Promise<{resumeId, docxFile, pdfFile, dir, tailored}>}
 * @throws Error('no_base_resume') | Error('needs_ai_provider') | Error('tailor_failed')
 */
async function tailorResume(db, { job, baseResumeText, settings = {}, opts = {} }) {
  if (!baseResumeText || !baseResumeText.trim()) throw new Error('no_base_resume');
  const provider = (settings.scoreProvider === 'haiku' || settings.scoreProvider === 'ollama')
    ? settings.scoreProvider : (opts.provider || null);
  if (!provider) throw new Error('needs_ai_provider');

  const tailored = await generateJSON({
    provider,
    prompt: buildTailorPrompt(job, baseResumeText, opts.skillsProfile || settings.skillsProfile || ''),
    schema: TAILOR_SCHEMA,
    system: 'You tailor resumes truthfully for a specific job. You NEVER fabricate experience, titles, skills, or dates.',
    opts: { ...opts, anthropicKey: settings.anthropicKey || opts.anthropicKey },
  });
  if (!tailored || !Array.isArray(tailored.sections)) throw new Error('tailor_failed');

  const dir = opts.outDir || path.join(homeDir(), 'resumes');
  fs.mkdirSync(dir, { recursive: true });
  const namePrefix = sanitize(settings.candidateName || tailored.name || 'Resume') || 'Resume';
  const base = `${namePrefix}_${sanitize(job.companyName) || 'Company'}`;
  const docxFile = base + '.docx';
  const pdfFile = base + '.pdf';
  fs.writeFileSync(path.join(dir, docxFile), await renderDocx(tailored));
  fs.writeFileSync(path.join(dir, pdfFile), await renderPdf(tailored));

  const id = 'r_' + Date.now();
  db.putResume({
    id, file: docxFile, company: job.companyName || '', role: job.title || '',
    created: new Date().toISOString().slice(0, 10), type: 'tailored', folder: dir, archived: false,
  });
  return { resumeId: id, docxFile, pdfFile, dir, tailored };
}

module.exports = { tailorResume, buildTailorPrompt, renderDocx, renderPdf, TAILOR_SCHEMA, homeDir };
