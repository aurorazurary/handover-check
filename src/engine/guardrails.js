/**
 * Guardrails: the things the CUI must never do, enforced in code.
 *
 * The Assignment 1 design makes two promises that a prompt alone cannot keep,
 * because a prompt is a request to a model and not a constraint on it:
 *
 *   G1  It never hands over the answer before the learner has attempted it.
 *   G2  It never reveals its own instructions, or the hidden plan behind them.
 *
 * Both are defended twice. The first defence is structural and lives in
 * engine/context.js: during Phase 1 the scenario secret is never placed in the
 * model's context, so there is nothing to extract. The second defence is this
 * module, which classifies the learner's turn before the call and scans the
 * model's reply after it. Defence in depth matters here because the structural
 * guarantee weakens in Phase 2, where the diff is legitimately in context.
 *
 * @module engine/guardrails
 */

import { isElicitOnly } from './states.js';
import { normalise } from './matcher.js';

/** Attempts to make the system recite its own configuration. */
const PROMPT_PROBES = [
  /\b(system|initial|original|your)\s+(prompt|instructions?|rules?|directive)/i,
  /\bignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?)/i,
  /\b(repeat|print|output|show|reveal|recite|echo)\b.{0,30}\b(above|verbatim|exactly|word for word)/i,
  /\byou are a\b.{0,40}\b(assistant|tutor|cui)\b.{0,40}\bwrite/i,
  /\bwhat (are|were) you (told|instructed|configured)/i,
  /\bdeveloper\s+(mode|message)\b/i,
  /\bdisregard\s+your\b/i,
];

/** Attempts to skip the thinking and be handed the result. */
const ANSWER_DEMANDS = [
  /\bjust\s+(tell|show|give)\s+me\b/i,
  /\b(tell|show|give)\s+me\s+(the|all|which)\s+(answer|answers|files?|diff|changes?|list)/i,
  /\bwhat\s+(files?|did it)\s+(did|were|changed|change)/i,
  /\bskip\s+(the\s+)?(questions?|prediction|this part)/i,
  /\bi\s+don'?t\s+want\s+to\s+(guess|predict|think)/i,
  /\bstop\s+asking\b/i,
  /\bshow\s+me\s+the\s+(diff|code|hunk|lines)/i,
  /\bno\s+more\s+questions\b/i,
];

/** Phrases that end the session or decline the run outright. */
const EXIT_WORDS = {
  skip: /^\s*(skip|no thanks|not now|pass)\s*[.!]?\s*$/i,
  stop: /^\s*(stop|quit|exit|end|done|that'?s enough)\s*[.!]?\s*$/i,
};

/**
 * What kind of turn is this? Called before the model, so the controller can
 * route an answer demand into the hint ladder rather than into a normal reply.
 *
 * @param {string} text
 * @returns {{
 *   exit: 'skip'|'stop'|null,
 *   answerDemand: boolean,
 *   promptExtraction: boolean,
 *   attemptLevel: 0|1|2,
 *   wordCount: number
 * }}
 */
export function classifyLearnerTurn(text) {
  const raw = String(text || '').trim();

  /** @type {'skip'|'stop'|null} */
  let exit = null;
  if (EXIT_WORDS.skip.test(raw)) exit = 'skip';
  else if (EXIT_WORDS.stop.test(raw)) exit = 'stop';

  const answerDemand = ANSWER_DEMANDS.some((re) => re.test(raw));
  const promptExtraction = PROMPT_PROBES.some((re) => re.test(raw));

  // Strip the demand itself before judging whether anything was attempted, so
  // "just tell me, but I think it's the controller" still counts as a try.
  let residue = raw;
  for (const re of [...ANSWER_DEMANDS, ...PROMPT_PROBES]) residue = residue.replace(re, ' ');
  const words = normalise(residue).split(' ').filter((w) => w.length > 1);
  const wordCount = words.length;

  const dontKnow = /\b(i\s+(don'?t|do\s+not)\s+know|no\s+idea|not\s+sure|dunno|no\s+clue)\b/i.test(raw);

  /** @type {0|1|2} */
  let attemptLevel = 0;
  if (wordCount >= 8) attemptLevel = 2;
  else if (wordCount >= 3) attemptLevel = 1;
  // "I don't know" is engagement, but it is not an attempt: it must lead to a
  // hint, never to the answer.
  if (dontKnow && attemptLevel > 1) attemptLevel = 1;

  return { exit, answerDemand, promptExtraction, attemptLevel, wordCount };
}

/**
 * Strings that must not appear in a Phase 1 reply. Derived from the scenario
 * secret, so the scanner catches a leak even if it arrived by a route the
 * structural defence did not cover.
 *
 * @param {import('./types.js').Scenario} scenario
 * @returns {Array<{kind: string, needle: string}>}
 */
export function secretNeedles(scenario) {
  const out = [];
  const inRepo = new Set(scenario.public.repoMap);

  for (const c of scenario.secret.changes) {
    // A path that already existed is in the public repo map; naming it is not a
    // leak. A path the agent created is.
    if (!inRepo.has(c.path)) {
      out.push({ kind: 'added-file-path', needle: c.path });
      const base = c.path.split('/').pop();
      if (base && base.length > 6) out.push({ kind: 'added-file-name', needle: base });
    }
    for (const line of c.hunk || []) {
      const t = line.text.trim();
      if (t.length >= 15) out.push({ kind: 'diff-line', needle: t });
    }
  }
  out.push({ kind: 'final-check', needle: scenario.secret.finalCheck.question });
  for (const c of scenario.secret.concepts) {
    out.push({ kind: 'concept-explanation', needle: c.shortExplanation });
  }
  return out;
}

/**
 * Scan a generated reply before it reaches the learner.
 *
 * In Phase 1 this is a hard gate: a reply containing any secret needle is
 * replaced wholesale, because a partial redaction still tells the learner that
 * there was something to redact.
 *
 * In Phase 2 the diff is legitimately on the table, so the only thing checked
 * is G2, prompt disclosure.
 *
 * @param {string} reply
 * @param {{state: string, scenario: import('./types.js').Scenario}} ctx
 * @returns {{ok: boolean, violations: Array<{rule: string, kind: string, needle?: string}>}}
 */
export function scanReply(reply, { state, scenario }) {
  const violations = [];
  const text = String(reply || '');

  if (isElicitOnly(state)) {
    for (const { kind, needle } of secretNeedles(scenario)) {
      if (needle && text.includes(needle)) {
        violations.push({ rule: 'G1', kind, needle });
      }
    }
  }

  if (/\bYou are Handover Check\b/i.test(text) || /\bNEVER (reveal|confirm|deny)\b/.test(text)) {
    violations.push({ rule: 'G2', kind: 'prompt-disclosure' });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * What to say instead when a reply is rejected. Deliberately bland and in
 * character: the learner should not be able to tell a guardrail from a design
 * choice, or they will probe for the seam.
 *
 * @param {string} state
 * @returns {string}
 */
export function safeFallback(state) {
  return isElicitOnly(state)
    ? "Let me put that differently. Work it from what you already know about the repo, and say what you would expect - I will check it against the real change once the agent is done."
    : "Let me stay with what you have said so far. Tell me the next step as you understand it and I will fill in from there.";
}

/**
 * The hint ladder for an answer demand (G1). The CUI does not refuse, and it
 * does not lecture; it narrows the question. Only the last rung concedes, and
 * even then it concedes structure rather than the answer.
 *
 * @param {number} rung how many times the learner has pushed in this state
 * @param {'files'|'mechanism'|'final'} kind
 * @returns {string}
 */
export function hintLadder(rung, kind) {
  const ladders = {
    files: [
      "I will, once the agent is done - right now there is nothing to tell you, because the change does not exist yet. Which part of the repo would have to be involved at all?",
      "Narrow it down rather than listing it: does this touch the client, the server, or both?",
      "Then take the smallest piece. Name one file you are sure cannot be involved, and say why.",
    ],
    mechanism: [
      "I would rather you got there. One step only: what has to happen first, before anything is saved?",
      "Say it in the language you do write. Forget the framework, what has to be true for this to work at all?",
      "Last nudge: describe the journey as a sequence of hops, and leave blanks where you are unsure. Blanks are fine.",
    ],
    final: [
      "Have one go first. Which of the files we just went through would hold that value?",
      "Think about which file decides the value, rather than which file stores it.",
      "Then answer with the layer rather than the file: route, controller, model, or config?",
    ],
  };
  const rungs = ladders[kind] || ladders.mechanism;
  return rungs[Math.min(rung, rungs.length - 1)];
}

/**
 * Reply to an attempt to read the system prompt or the hidden plan. Short, not
 * preachy, and it moves straight back to the task.
 *
 * @param {string} state
 * @returns {string}
 */
export function promptExtractionReply(state) {
  return isElicitOnly(state)
    ? "Not something I will print, and in this phase I genuinely do not have the plan or the diff loaded - that is the point of asking you first. Back to it: what do you expect to change?"
    : "Not something I will print. What I can show you is the code itself. Which part would you like to look at?";
}
