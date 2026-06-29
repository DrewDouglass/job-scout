/**
 * ai.js — provider-agnostic job scoring (1-10 + reason), replacing Adli's window.cowork.askClaude seam.
 *
 * Tiered, portability-first for the Boat:
 *   - 'keyword' (DEFAULT): Adli's ported keywordScore — free, zero-dep, instant, works for all 32 with no key/GPU/spend.
 *   - 'haiku'  : Anthropic Messages API, claude-haiku-4-5, output_config.format strict-JSON. User's OWN ANTHROPIC_API_KEY.
 *   - 'ollama' : local Ollama /api/chat, format=JSON-schema constrained decoding, temp 0. Drew points his at Narasimha
 *                over an SSH tunnel (127.0.0.1:11434); other users at their own box. Narasimha is NOT bundled (Drew-only).
 *
 * The scoring PROMPT is Adli's product win, ported faithfully. Whatever the provider, results are
 * parse + range-checked(1-10), and ANY job the model didn't score falls back to keywordScore — so a
 * provider hiccup never leaves a job unscored (Adli's posture). Zero npm deps (Node global fetch).
 */

const { keywordScore, keywordScoreWithReason } = require('./keyword');

const HAIKU_MODEL = 'claude-haiku-4-5';                 // verified id/pricing via the claude-api skill ($1/$5 per 1M)
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434/api/chat';
const OLLAMA_DEFAULT_MODEL = 'qwen2.5:14b';

// Object-rooted schema (bare-array roots trip some constrained-decoding grammars; research-backed).
const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores'],
  properties: {
    scores: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['index', 'score', 'reason'],
        properties: { index: { type: 'integer' }, score: { type: 'integer' }, reason: { type: 'string' } },
      },
    },
  },
};

/** Adli's dismissal-context block: "downweight similar jobs" from dismissed reasons. */
function dismissalContext(dismissedMap) {
  const entries = Object.values(dismissedMap || {}).filter(d => d && d.reason);
  if (!entries.length) return '';
  const counts = {};
  for (const { reason } of entries) counts[reason] = (counts[reason] || 0) + 1;
  const lines = Object.entries(counts).sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `  - "${r}"${n > 1 ? ` (${n}x)` : ''}`).join('\n');
  return `\n\nUser feedback from previously dismissed roles (downweight similar jobs):\n${lines}`;
}

/** PURE: build Adli's scoring prompt for a batch of jobs. Asks for {scores:[...]} (object root for structured output). */
function buildScorePrompt(jobs, settings = {}, dismissedMap = {}) {
  const profile = settings.profile || settings.candidateName || 'the candidate';
  const metro = (settings.localMetroCities && settings.localMetroCities.length)
    ? settings.localMetroCities.slice(0, 4).join(', ')
    : (settings.location || "the candidate's local area");
  const penaltyTerms = settings.scorePenaltyTerms || [];
  const penaltyLine = penaltyTerms.length
    ? `\n- Job primarily requires ${penaltyTerms.join(', ')} (not in candidate's stack) = subtract 1` : '';
  const list = jobs.map((j, i) =>
    `[${i + 1}] "${j.title}" at ${j.companyName} | ${(j.workplaceTypes || []).join('/') || 'unknown'} | Salary: ${j.salary || 'not listed'} | Source: ${j.source}\nSummary: ${(j.summary || '').slice(0, 200)}`
  ).join('\n\n');
  return `Score these ${jobs.length} job listings for this candidate:
${profile}${dismissalContext(dismissedMap)}

SCORING: 9-10=excellent match for the candidate's stack/seniority, remote/hybrid. 7-8=good fit. 5-6=partial. 1-4=poor.
ADJUSTMENTS:
- Security clearance OR defense/military/homeland = subtract 2 (min 1)
- Hybrid role outside ${metro} = score 0 (auto-exclude)${penaltyLine}

JOBS:
${list}

Return ONLY JSON matching this schema: an object {"scores": [{"index":1,"score":8,"reason":"..."}]} — one entry per job, score 1-10, a short plain reason.`;
}

/** Tolerantly pull the {scores:[...]} array out of a model's text. */
function parseScores(text) {
  if (!text) return null;
  let obj = null;
  try { obj = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
    if (m) { try { obj = JSON.parse(m[0]); } catch { return null; } }
  }
  if (!obj) return null;
  const arr = Array.isArray(obj) ? obj : obj.scores;
  return Array.isArray(arr) && arr.length ? arr : null;
}

const clamp = (n) => Math.max(1, Math.min(10, Math.round(Number(n) || 0)));

// ─── providers ─────────────────────────────────────────────────────────────────
async function scoreWithHaiku(prompt, opts) {
  const key = opts.anthropicKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('no_anthropic_key');
  const doFetch = opts.fetchImpl || fetch;
  const res = await doFetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || HAIKU_MODEL, max_tokens: 4096,
      output_config: { format: { type: 'json_schema', schema: SCORE_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic_http_${res.status}`);
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return parseScores(text);
}

async function scoreWithOllama(prompt, opts) {
  const url = opts.ollamaUrl || process.env.OLLAMA_URL || OLLAMA_DEFAULT_URL;
  const doFetch = opts.fetchImpl || fetch;
  const res = await doFetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || process.env.OLLAMA_MODEL || OLLAMA_DEFAULT_MODEL,
      stream: false, format: SCORE_SCHEMA, options: { temperature: 0, num_ctx: 8192 },
      messages: [
        { role: 'system', content: 'You score job listings 1-10. Return ONLY JSON matching the schema.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama_http_${res.status}`);
  const data = await res.json();
  return parseScores(data.message?.content || '');
}

/**
 * Score a batch of jobs, returning each job with matchScore (1-10) + matchReason.
 * @param {object[]} jobs
 * @param {object} opts {provider, settings, dismissedMap, anthropicKey, ollamaUrl, model, fetchImpl, onStatus}
 * @returns {Promise<{jobs:object[], provider:string, aiUsed:boolean, error:string|null}>}
 */
async function scoreJobs(jobs, opts = {}) {
  const settings = opts.settings || {};
  const dismissedMap = opts.dismissedMap || {};
  const penaltyTerms = settings.scorePenaltyTerms || [];
  const provider = opts.provider || settings.scoreProvider || 'keyword';
  if (!jobs || !jobs.length) return { jobs: [], provider, aiUsed: false, error: null };

  // keyword baseline for every job (also the fallback for any the model skips)
  const kwResults = jobs.map(j => keywordScoreWithReason(j, penaltyTerms));
  const kw = kwResults.map(r => clamp(r.score));

  if (provider === 'keyword') {
    return { jobs: jobs.map((j, i) => ({ ...j, matchScore: kw[i], matchReason: kwResults[i].reason })), provider, aiUsed: false, error: null };
  }

  const prompt = buildScorePrompt(jobs, settings, dismissedMap);
  const call = provider === 'haiku' ? scoreWithHaiku : scoreWithOllama;
  let scores = null, error = null;
  for (let attempt = 0; attempt < 2 && !scores; attempt++) {     // parse + validate + single retry
    if (opts.onStatus) opts.onStatus(`Scoring ${jobs.length} jobs via ${provider}${attempt ? ' (retry)' : ''}…`);
    try {
      const raw = await call(prompt, opts);
      if (raw && raw.length) scores = raw;
    } catch (e) { error = String(e && e.message || e); break; } // a hard error (no key, http) → stop, fall back to keyword
  }

  const byIndex = {};
  if (scores) for (const s of scores) if (s && Number.isFinite(Number(s.index))) byIndex[Number(s.index) - 1] = s;

  const out = jobs.map((j, i) => {
    const s = byIndex[i];
    return {
      ...j,
      matchScore: s ? clamp(s.score) : kw[i],          // model score (range-checked) or keyword fallback
      matchReason: s && s.reason ? String(s.reason) : kwResults[i].reason,
    };
  });
  return { jobs: out, provider, aiUsed: !!scores, error: scores ? null : (error || 'no_valid_scores') };
}

/** Parse an object out of model text (tolerant of chatty wrappers). */
function safeParseObject(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = String(text).match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
  return null;
}

/**
 * Generic structured generation against a provider (reused by resume tailoring).
 * @returns {Promise<object|null>} parsed object matching `schema`, or null on a parse miss.
 * @throws on no key / http error / a provider with no model (e.g. 'keyword').
 */
async function generateJSON({ provider, prompt, schema, system, opts = {} }) {
  const doFetch = opts.fetchImpl || fetch;
  if (provider === 'haiku') {
    const key = opts.anthropicKey || process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('no_anthropic_key');
    const res = await doFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model || HAIKU_MODEL, max_tokens: opts.maxTokens || 4096,
        output_config: { format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: (system ? system + '\n\n' : '') + prompt }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic_http_${res.status}`);
    const data = await res.json();
    return safeParseObject((data.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
  }
  if (provider === 'ollama') {
    const url = opts.ollamaUrl || process.env.OLLAMA_URL || OLLAMA_DEFAULT_URL;
    const res = await doFetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model || process.env.OLLAMA_MODEL || OLLAMA_DEFAULT_MODEL,
        stream: false, format: schema, options: { temperature: 0, num_ctx: opts.numCtx || 8192 },
        messages: [{ role: 'system', content: system || 'Return ONLY JSON matching the schema.' }, { role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`ollama_http_${res.status}`);
    const data = await res.json();
    return safeParseObject(data.message?.content || '');
  }
  throw new Error(`needs_ai_provider`); // 'keyword' (or unknown) can't generate — caller surfaces a friendly message
}

module.exports = { scoreJobs, buildScorePrompt, parseScores, dismissalContext, generateJSON, safeParseObject, SCORE_SCHEMA, HAIKU_MODEL };
