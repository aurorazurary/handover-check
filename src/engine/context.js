/**
 * Building the model's context, and the boundary that keeps the plan hidden.
 *
 * This module is the structural half of guardrail G1. Everything else in the
 * system asks the model not to reveal the change early. This module makes that
 * impossible to disobey, by never putting the change in the context at all:
 *
 *   buildPhase1Context()  reads scenarios.publicView() only. It has no access
 *                         to the plan, the diff, the concepts or the final
 *                         check, so a jailbreak in Phase 1 has nothing to find.
 *
 *   buildPhase2Context()  calls scenarios.secretView(), which throws unless the
 *                         session has already reached Phase 2, and then passes
 *                         in only the one gap being addressed this turn rather
 *                         than the whole diff.
 *
 * The second point matters as much as the first. Even in Phase 2 the model is
 * given the file currently under discussion and nothing else, so it cannot
 * volunteer the next three gaps and finish the learner's work for them.
 *
 * @module engine/context
 */

import { publicView, secretView } from './scenarios.js';
import { render } from '../llm/prompts.js';
import { phaseOf } from './states.js';

/** How many previous turns to carry. Enough for the model to build on the
 *  learner's last answer, short enough that it does not drift into summarising
 *  the conversation back at them. */
const HISTORY_TURNS = 8;

/**
 * @param {import('./types.js').Session} session
 * @returns {Array<{role: 'user'|'assistant', content: string}>}
 */
function history(session) {
  const raw = session.transcript
    .filter((t) => (t.role === 'learner' || t.role === 'cui') && String(t.content || '').trim())
    .slice(-HISTORY_TURNS)
    .map((t) => ({
      role: /** @type {'user'|'assistant'} */ (t.role === 'learner' ? 'user' : 'assistant'),
      content: t.content,
    }));

  // Two shapes the Messages API rejects, both of which this conversation can
  // reach legitimately.
  //
  // 1. Consecutive turns from the same side. The CUI speaks twice in a row
  //    when the coding agent interrupts and then resumes, so those are merged.
  // 2. A trailing assistant turn. That happens whenever the session advances
  //    without the learner saying anything, which is how the agent finishing
  //    moves us into Phase 2. The model refuses to continue its own turn, so a
  //    short cue is added saying what moved the conversation on.
  /** @type {Array<{role: 'user'|'assistant', content: string}>} */
  const merged = [];
  for (const m of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `

${m.content}`;
    else merged.push({ ...m });
  }

  if (!merged.length || merged[merged.length - 1].role === 'assistant') {
    merged.push({ role: 'user', content: '(the coding agent has finished)' });
  }
  return merged;
}

/**
 * Describe the learner's background for the persona block, so analogies land in
 * a language they actually write.
 *
 * @param {import('./types.js').Session} session
 * @returns {string}
 */
function background(session) {
  const langs = session.settings.writes || [];
  if (!langs.length) return 'not stated';
  return `writes ${langs.join(' and ')} confidently; reads the language in this repo but would not write it unaided`;
}

/**
 * Phase 1. The model is told what the learner asked for and how the repo is
 * laid out. It is not told what changed, because nothing has changed yet.
 *
 * @param {object} args
 * @param {import('./types.js').Session} args.session
 * @param {import('./types.js').Scenario} args.scenario
 * @param {string} args.turnGoal what this turn is for, in the imperative
 * @param {string} [args.priorContext] anything the controller computed that the
 *   model needs, such as the learner's last answer restated as a fact
 * @returns {{system: string, messages: Array<{role: 'user'|'assistant', content: string}>}}
 */
export function buildPhase1Context({ session, scenario, turnGoal, priorContext = '' }) {
  if (phaseOf(session.state) !== 1) {
    throw new Error(`buildPhase1Context called in ${session.state}, which is Phase 2`);
  }
  const pub = publicView(scenario);

  const system = render('phase1_elicit', {
    LEARNER_BACKGROUND: background(session),
    REQUEST: pub.request,
    CONVENTIONS: pub.conventions,
    REPO_MAP: pub.repoMap.map((p) => `- ${p}`).join('\n'),
    TURN_GOAL: turnGoal,
    PRIOR_CONTEXT: priorContext,
  }, session.settings.promptVersion);

  // The learner's own words are quoted back to the model in PRIOR_CONTEXT. If
  // they guessed a path that turns out to be one the agent created, that is
  // their guess, not a disclosure, so it is removed before the assertion runs.
  assertNoSecret(system, scenario, 'phase 1 system prompt', priorContext);
  return { system, messages: history(session) };
}

/**
 * Phase 2. The model receives the learner's own prediction, a summary of what
 * actually changed, and **one** gap.
 *
 * @param {object} args
 * @param {import('./types.js').Session} args.session
 * @param {import('./types.js').Scenario} args.scenario
 * @param {string} args.turnGoal
 * @param {string} args.predictionSummary what the learner said, in Phase 1
 * @param {string} args.actualSummary what changed, at the level of file roles
 * @param {string} args.gap the single thing this turn addresses, including the
 *   hunk if lines are to be shown
 * @param {string} [args.priorContext]
 * @returns {{system: string, messages: Array<{role: 'user'|'assistant', content: string}>}}
 */
export function buildPhase2Context({
  session, scenario, turnGoal, predictionSummary, actualSummary, gap, priorContext = '',
}) {
  // Throws unless the session really has reached Phase 2.
  secretView(scenario, session);

  const system = render('phase2_reconcile', {
    LEARNER_BACKGROUND: background(session),
    REQUEST: scenario.public.request,
    PREDICTION: predictionSummary,
    ACTUAL: actualSummary,
    GAP: gap,
    TURN_GOAL: turnGoal,
    PRIOR_CONTEXT: priorContext,
  }, session.settings.promptVersion);

  return { system, messages: history(session) };
}

/**
 * Render a change's hunk as text for the prompt, so the model quotes real lines
 * rather than inventing plausible ones.
 *
 * @param {import('./types.js').Change} change
 * @returns {string}
 */
export function hunkText(change) {
  if (!change.hunk?.length) return '(no lines recorded for this file)';
  const sign = { add: '+', del: '-', ctx: ' ' };
  return [
    `${change.path}:`,
    ...change.hunk.map((l) => `${sign[l.type] ?? ' '} ${l.text}`),
  ].join('\n');
}

/**
 * Last line of defence on the way in rather than on the way out: assert that a
 * prompt we are about to send contains nothing from the scenario secret.
 *
 * Only applied to Phase 1, where the correct amount of secret is zero.
 *
 * @param {string} text
 * @param {import('./types.js').Scenario} scenario
 * @param {string} label
 * @param {string} [quoted] a passage quoting the learner, excluded from the scan
 */
export function assertNoSecret(text, scenario, label, quoted = '') {
  const scanned = quoted ? text.split(quoted).join(' ') : text;
  const inRepo = new Set(scenario.public.repoMap);
  for (const c of scenario.secret.changes) {
    if (!inRepo.has(c.path) && scanned.includes(c.path)) {
      throw new Error(`${label} contains the added path ${c.path}`);
    }
    for (const line of c.hunk || []) {
      if (line.text.trim().length >= 15 && scanned.includes(line.text.trim())) {
        throw new Error(`${label} contains a diff line from ${c.path}`);
      }
    }
  }
  if (scanned.includes(scenario.secret.finalCheck.question)) {
    throw new Error(`${label} contains the final check question`);
  }
}
