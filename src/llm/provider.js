/**
 * The only place in the system that talks to a language model.
 *
 * Everything else calls `complete()` or `completeJSON()`, so swapping the model
 * or running without a key is a configuration change and never a code change.
 * That also means the judge in llm_judge/ can use a different model from the
 * system it is judging, which it should: a judge that shares the system's
 * blind spots will not find them.
 *
 * @module llm/provider
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const PROVIDER = process.env.HC_PROVIDER || 'anthropic';
const MODEL = process.env.HC_MODEL || 'claude-sonnet-5';

/** @type {Anthropic|null} */
let client = null;

/** Lazily constructed so that `npm test` runs with no key present. */
function anthropic() {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key, '
        + 'or set HC_PROVIDER=mock to run the interaction with canned replies.',
      );
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * @typedef {{role: 'user'|'assistant', content: string}} Msg
 */

/**
 * Newer Claude models reject `temperature` outright rather than ignoring it:
 *
 *   400 invalid_request_error: `temperature` is deprecated for this model.
 *
 * So it is only sent when the caller opts in with HC_SEND_TEMPERATURE=1, which
 * is what an older model would need. Leaving it off costs nothing here: the
 * variation between simulated learners comes from their persona prompts, and
 * grading is pinned by asking for JSON against a fixed rubric rather than by
 * setting temperature to zero.
 */
const SEND_TEMPERATURE = process.env.HC_SEND_TEMPERATURE === '1';

/**
 * Ask the model for a reply.
 *
 * @param {object} opts
 * @param {string} opts.system the system prompt
 * @param {Msg[]} opts.messages conversation so far
 * @param {number} [opts.maxTokens] a ceiling, not a target. Reasoning models
 *   spend part of this budget thinking before they write, so a budget sized to
 *   the expected reply produces no reply at all. Reply length is controlled by
 *   the prompt, not by this number.
 * @param {number} [opts.temperature] only sent when HC_SEND_TEMPERATURE=1
 * @param {string} [opts.model] override, used by the judge
 * @returns {Promise<string>}
 */
export async function complete({
  system, messages, maxTokens = 2000, temperature = 0.3, model = MODEL,
}) {
  if (PROVIDER === 'mock') return mockComplete({ system, messages });

  const res = await anthropic().messages.create({
    model,
    max_tokens: maxTokens,
    ...(SEND_TEMPERATURE ? { temperature } : {}),
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  });

  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  // Reasoning models spend output tokens on thinking before they emit any
  // text. If max_tokens runs out first the call returns 200 with an empty
  // string, which every caller then treats as a reply. Fail loudly instead:
  // a silent empty reply is how a grading call degrades to its fallback
  // without anybody noticing.
  if (!text && res.stop_reason === 'max_tokens') {
    throw new Error(
      `Model produced no text: the ${maxTokens} token budget was consumed before output `
      + `(${res.usage?.output_tokens_details?.thinking_tokens ?? '?'} thinking tokens). `
      + 'Raise maxTokens for this call.',
    );
  }
  return text;
}

/**
 * Ask for a JSON object. Used for grading, where a free-text answer would have
 * to be parsed anyway and parsing prose is how graders disagree with each other.
 *
 * The model is asked for JSON and the first balanced object in the reply is
 * taken, which survives the occasional prose preamble.
 *
 * @param {object} opts same as complete(), plus:
 * @param {string} opts.system
 * @param {Msg[]} opts.messages
 * @param {object} [opts.fallback] returned if parsing fails, so a bad reply
 *   degrades the grade rather than crashing the learner's session. It comes
 *   back tagged with `_fallback: true` and a warning on stderr, because a
 *   silent degradation is indistinguishable from a real grade.
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.model]
 * @returns {Promise<any>}
 */
export async function completeJSON({
  system, messages, fallback = null, maxTokens = 4000, model = MODEL,
}) {
  if (PROVIDER === 'mock') return mockJSON({ system, messages, fallback });

  const text = await complete({
    system: `${system}\n\nReply with a single JSON object and nothing else.`,
    messages,
    maxTokens,
    temperature: 0,
    model,
  });

  const parsed = extractJSON(text);
  if (parsed === undefined) {
    if (fallback !== null) {
      // Announce it. A fallback that nobody sees is a result nobody can trust:
      // every conversation in the first judge run was graded by this path
      // without a word of warning.
      console.warn(`[provider] completeJSON fell back to the default. Reply began: ${text.slice(0, 120)}`);
      return { ...fallback, _fallback: true };
    }
    throw new Error(`Model did not return JSON. Got: ${text.slice(0, 200)}`);
  }
  return parsed;
}

/**
 * Pull the first balanced JSON object out of a string.
 * @param {string} text
 * @returns {any|undefined}
 */
export function extractJSON(text) {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
      }
    }
  }
  return undefined;
}

/** @returns {{provider: string, model: string, live: boolean}} */
export function providerInfo() {
  return { provider: PROVIDER, model: MODEL, live: PROVIDER !== 'mock' };
}

// ---------------------------------------------------------------------------
// Mock provider
//
// Lets the whole interaction be demonstrated without a key, and makes the
// server's own tests runnable offline. It is NOT a stand-in for the real
// provider when testing: it cannot grade a free-text explanation, so every
// mock grade is a fixed "partial". The judge runs refuse to start in mock mode.
// ---------------------------------------------------------------------------

/** @param {{system: string, messages: Msg[]}} _ */
function mockComplete({ messages }) {
  const last = messages[messages.length - 1]?.content || '';
  return `[mock] Noted: "${last.slice(0, 60)}". `
    + 'Running with HC_PROVIDER=mock, so this reply is canned rather than generated.';
}

/** @param {{system: string, messages: Msg[], fallback: any}} opts */
function mockJSON({ fallback }) {
  return fallback ?? {
    verdict: 'partial',
    covered: [],
    missing: [],
    note: '[mock] no grading in mock mode',
  };
}
