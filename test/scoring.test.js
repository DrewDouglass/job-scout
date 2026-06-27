/**
 * scoring.test.js — provider-agnostic scoring: keyword default, Haiku/Ollama (mocked), fallback, clamping.
 * Run: node --test test/scoring.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreJobs, buildScorePrompt, parseScores, dismissalContext } = require('../src/scoring/ai');

const jobs = [
  { title: 'Senior SDET', companyName: 'Acme', workplaceTypes: ['Remote'], salary: '$150k', source: 'LinkedIn', summary: 'Python API automation', isRemote: true },
  { title: 'QA Lead', companyName: 'Beta', workplaceTypes: ['On-site'], salary: null, source: 'Indeed', summary: 'manual testing', isRemote: false },
];

describe('buildScorePrompt', () => {
  it('embeds profile, jobs, penalty terms, dismissal context', () => {
    const p = buildScorePrompt(jobs, { profile: 'Senior QE, Python', scorePenaltyTerms: ['java'], localMetroCities: ['denver'] },
      { g1: { reason: 'too junior' } });
    assert.ok(p.includes('Senior QE, Python'));
    assert.ok(p.includes('Senior SDET'));
    assert.ok(p.includes('subtract 1'));            // penalty line present
    assert.ok(p.includes('too junior'));            // dismissal context
    assert.ok(p.includes('Hybrid role outside denver'));
  });
});

describe('parseScores', () => {
  it('parses an object root', () => {
    assert.deepEqual(parseScores('{"scores":[{"index":1,"score":8,"reason":"x"}]}'), [{ index: 1, score: 8, reason: 'x' }]);
  });
  it('parses a bare array', () => {
    assert.equal(parseScores('[{"index":1,"score":7,"reason":"y"}]').length, 1);
  });
  it('digs JSON out of chatty text', () => {
    assert.ok(parseScores('Here you go: {"scores":[{"index":1,"score":9,"reason":"z"}]} done'));
  });
  it('returns null on garbage', () => { assert.equal(parseScores('not json'), null); });
});

describe('dismissalContext', () => {
  it('aggregates and counts reasons', () => {
    const c = dismissalContext({ a: { reason: 'defense' }, b: { reason: 'defense' }, d: { reason: 'junior' } });
    assert.ok(c.includes('"defense" (2x)'));
    assert.ok(c.includes('"junior"'));
  });
});

describe('scoreJobs', () => {
  it('keyword provider is the free default (no network)', async () => {
    const r = await scoreJobs(jobs, { provider: 'keyword', settings: {} });
    assert.equal(r.aiUsed, false);
    assert.equal(r.provider, 'keyword');
    assert.ok(r.jobs[0].matchScore >= 1 && r.jobs[0].matchScore <= 10);
    assert.equal(r.jobs[0].matchReason, 'keyword match');
  });

  it('haiku provider (mocked) parses scores from the Anthropic response', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"scores":[{"index":1,"score":9,"reason":"great"},{"index":2,"score":4,"reason":"meh"}]}' }] }) });
    const r = await scoreJobs(jobs, { provider: 'haiku', anthropicKey: 'K', fetchImpl });
    assert.equal(r.aiUsed, true);
    assert.equal(r.jobs[0].matchScore, 9);
    assert.equal(r.jobs[0].matchReason, 'great');
    assert.equal(r.jobs[1].matchScore, 4);
  });

  it('ollama provider (mocked) parses message.content', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ message: { content: '{"scores":[{"index":1,"score":8,"reason":"fit"},{"index":2,"score":5,"reason":"ok"}]}' } }) });
    const r = await scoreJobs(jobs, { provider: 'ollama', fetchImpl });
    assert.equal(r.aiUsed, true);
    assert.equal(r.jobs[0].matchScore, 8);
  });

  it('falls back to keyword when the provider errors (never leaves jobs unscored)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const r = await scoreJobs(jobs, { provider: 'haiku', anthropicKey: 'K', fetchImpl });
    assert.equal(r.aiUsed, false);
    assert.ok(r.error);
    assert.ok(r.jobs.every(j => j.matchScore >= 1 && j.matchScore <= 10)); // every job still scored
  });

  it('falls back to keyword when no Anthropic key', async () => {
    const r = await scoreJobs(jobs, { provider: 'haiku', anthropicKey: '', fetchImpl: async () => { throw new Error('nope'); } });
    assert.equal(r.error, 'no_anthropic_key');
    assert.ok(r.jobs.every(j => typeof j.matchScore === 'number'));
  });

  it('clamps out-of-range model scores and keyword-fills a skipped job', async () => {
    // model returns score 99 for job 1 and omits job 2 entirely
    const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"scores":[{"index":1,"score":99,"reason":"hot"}]}' }] }) });
    const r = await scoreJobs(jobs, { provider: 'haiku', anthropicKey: 'K', fetchImpl });
    assert.equal(r.jobs[0].matchScore, 10);                 // clamped
    assert.equal(r.jobs[1].matchReason, 'keyword match');   // skipped job filled by keyword
    assert.ok(r.jobs[1].matchScore >= 1 && r.jobs[1].matchScore <= 10);
  });
});
