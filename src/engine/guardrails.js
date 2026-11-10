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
 * Everything the learner has said so far, lowercased, for exclusion checks.
 *
 * @param {import('./types.js').Session} [session]
 * @returns {string}
 */
export function learnerSaid(session) {
  if (!session?.transcript) return '';
  return session.transcript
    .filter((t) => t.role === 'learner')
    .map((t) => t.content)
    .join(' ')
    .toLowerCase();
}

/**
 * Strings that must not appear in a Phase 1 reply. Derived from the scenario
 * secret, so the scanner catches a leak even if it arrived by a route the
 * structural defence did not cover.
 *
 * Anything the learner has already said is excluded. A learner who guesses
 * "ForgotPassword.jsx" has not been told anything by the system repeating it
 * back, and treating that as a leak both fires falsely and punishes the
 * learners who guess most specifically.
 *
 * @param {import('./types.js').Scenario} scenario
 * @param {string} [said] lowercased text the learner has already produced
 * @returns {Array<{kind: string, needle: string}>}
 */
export function secretNeedles(scenario, said = '') {
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
  return said
    ? out.filter(({ needle }) => needle && !said.includes(needle.toLowerCase()))
    : out;
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
 * @param {{state: string, scenario: import('./types.js').Scenario,
 *          session?: import('./types.js').Session}} ctx
 * @returns {{ok: boolean, violations: Array<{rule: string, kind: string, needle?: string}>}}
 */
export function scanReply(reply, { state, scenario, session }) {
  const violations = [];
  const text = String(reply || '');

  if (isElicitOnly(state)) {
    for (const { kind, needle } of secretNeedles(scenario, learnerSaid(session))) {
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

// ---------------------------------------------------------------------------
// One question at a time
// ---------------------------------------------------------------------------

/** Sentence openers that put a question to the learner even without a question mark. */
const ASKS_OPENERS = [
  /^(what|which|why|how|where|when|who)\s+(do|does|did|would|could|should|can|will|might|happens|happened|file|files|part|one|of|tells|makes|decides|line)\b/i,
  /^(does|did|do you|is (it|that|there|this)|are (you|they|there|these|those)|can you|could you|would you|should (it|you|that)|have you|has (it|that))\b/i,
  /^(tell me|say back|say why|say what|walk me|walk through|talk me|try (it|the|again|that)|have a think|take a stab|explain|describe)\b/i,
];

/** Requests to the learner that are requests wherever they sit in the sentence. */
const ASKS_ANYWHERE = /\b(tell me|say back|walk me through|talk me through)\b/i;

/** Connectives that can open a question without stopping it being one. */
const LEAD_IN = /^(so|and|but|then|now|first|okay|ok|right|given (that|this|all that)|with that in mind)\b[,:]?\s*/i;

/**
 * Whether a sentence puts something to the learner to answer. A question mark
 * is the easy case. The model also asks with a full stop ("What does that tell
 * you about the response, and why .json() would be wrong here.") and with
 * imperatives ("say back why it has to happen there"), and both read as a
 * question to a learner, so both count.
 *
 * @param {string} sentence
 * @returns {boolean}
 */
export function asksSomething(sentence) {
  let s = String(sentence).replace(/^[\s*_>"'`#-]+/, '').trim();
  if (/\?["')\]*_`]*$/.test(s)) return true;
  if (ASKS_ANYWHERE.test(s)) return true;
  for (let i = 0; i < 2; i += 1) {
    const t = s.replace(LEAD_IN, '');
    if (t === s) break;
    s = t;
  }
  return ASKS_OPENERS.some((re) => re.test(s));
}

/** Index just past the last closing code fence, so a cut never lands inside code. */
function fenceFloor(text) {
  const fences = [...text.matchAll(/```/g)];
  if (!fences.length) return 0;
  if (fences.length % 2 === 1) return text.length;
  return fences[fences.length - 1].index + 3;
}

/** Where the last sentence of the prose after `floor` begins. */
function lastSentenceStart(text, floor) {
  const re = /(?:\n+|[.!?]["')\]*_`]*[ \t]+)(?=\S)/g;
  re.lastIndex = floor;
  let idx = floor;
  let m;
  while ((m = re.exec(text))) idx = m.index + m[0].length;
  return idx;
}

/**
 * Make a reply end on a statement, by dropping any question it ends on.
 *
 * Used when the system is about to speak again in the same message: a state's
 * entry action is going to ask the next question, or the session is about to
 * close with the card. If the model's reply also ends on a question, the
 * learner gets two at once. They answer one, the code reads their answer as
 * the reply to the scripted one, and the model's question is never seen again.
 * When the next thing is the card, the question can never be answered at all.
 *
 * The prompt already says "end on a statement, the next question is asked for
 * you". Labelling the judge set showed that it does not hold. Replaying this
 * function over the 20 conversations, 17 of the 60 turns where the system
 * speaks twice end on a question of the model's own, including 12 of the 20
 * concept checks. A prompt is a request; this is the constraint.
 *
 * Only trailing questions are removed. Code fences are never cut into. If
 * nothing is left, `fallback` is used, which may itself be empty.
 *
 * @param {string} reply
 * @param {{fallback?: string}} [opts]
 * @returns {{text: string, stripped: string[]}}
 */
export function endOnStatement(reply, { fallback = '' } = {}) {
  let text = String(reply || '').trimEnd();
  const floor = fenceFloor(text);
  const stripped = [];

  for (let guard = 0; guard < 8 && text.length > floor; guard += 1) {
    const start = lastSentenceStart(text, floor);
    const sentence = text.slice(start).trim();
    if (!sentence || !asksSomething(sentence)) break;
    stripped.unshift(sentence);
    text = text.slice(0, start).trimEnd();
  }

  // A lead-in like "Here is the question that matters:" means nothing once
  // the question after it has gone.
  if (stripped.length && text.length > floor && /:$/.test(text)) {
    const start = lastSentenceStart(text, floor);
    stripped.unshift(text.slice(start).trim());
    text = text.slice(0, start).trimEnd();
  }

  if (stripped.length) text = text.replace(/\n[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/, '').trimEnd();

  if (!text.trim()) text = fallback;
  return { text, stripped };
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
