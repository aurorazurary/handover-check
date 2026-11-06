/**
 * The dialogue controller's states and the legal moves between them.
 *
 * This is Figure 1 of the Assignment 1 report, written down. It exists as data
 * rather than as branching inside the turn handler so that the three invariants
 * the design depends on are properties of the machine, not promises made in a
 * prompt:
 *
 *   1. No state in Phase 1 can read the plan or the diff   (ELICIT_ONLY)
 *   2. The agent can interrupt from any Phase 1 state       (PAUSED)
 *   3. The learner can leave from any state                 (skip / stop)
 *
 * @module engine/states
 */

/** @enum {string} */
export const S = {
  IDLE: 'IDLE',
  ACTIVATE: 'ACTIVATE',
  PREDICT_FILES: 'PREDICT_FILES',
  PREDICT_MECHANISM: 'PREDICT_MECHANISM',
  PAUSED: 'PAUSED',
  WAIT_FOR_AGENT: 'WAIT_FOR_AGENT',
  RECONCILE_FILES: 'RECONCILE_FILES',
  RECONCILE_MECHANISM: 'RECONCILE_MECHANISM',
  GROUND: 'GROUND',
  FINAL_CHECK: 'FINAL_CHECK',
  CARD: 'CARD',
  END: 'END',
};

/**
 * Which phase each state belongs to. Phase 1 states are ELICIT_ONLY: the
 * context builder refuses to put the scenario secret in their prompts, and the
 * guardrail scanner treats any mention of a changed file as a leak.
 *
 * @type {Record<string, 1|2>}
 */
export const PHASE = {
  [S.IDLE]: 1,
  [S.ACTIVATE]: 1,
  [S.PREDICT_FILES]: 1,
  [S.PREDICT_MECHANISM]: 1,
  [S.PAUSED]: 1,
  [S.WAIT_FOR_AGENT]: 1,
  [S.RECONCILE_FILES]: 2,
  [S.RECONCILE_MECHANISM]: 2,
  [S.GROUND]: 2,
  [S.FINAL_CHECK]: 2,
  [S.CARD]: 2,
  [S.END]: 2,
};

/** States in which the CUI must never confirm, deny, or name a changed file. */
export const ELICIT_ONLY = new Set([
  S.ACTIVATE, S.PREDICT_FILES, S.PREDICT_MECHANISM, S.PAUSED, S.WAIT_FOR_AGENT,
]);

/**
 * Normal forward moves. Interrupts (pause, skip, stop) are handled separately
 * in the controller because they are legal from many states at once.
 *
 * @type {Record<string, string>}
 */
export const NEXT = {
  [S.IDLE]: S.ACTIVATE,
  [S.ACTIVATE]: S.PREDICT_FILES,
  [S.PREDICT_FILES]: S.PREDICT_MECHANISM,
  [S.PREDICT_MECHANISM]: S.WAIT_FOR_AGENT,
  [S.WAIT_FOR_AGENT]: S.RECONCILE_FILES,
  [S.RECONCILE_FILES]: S.RECONCILE_MECHANISM,
  [S.RECONCILE_MECHANISM]: S.GROUND,
  [S.GROUND]: S.FINAL_CHECK,
  [S.FINAL_CHECK]: S.CARD,
  [S.CARD]: S.END,
};

/**
 * @param {string} state
 * @returns {1|2}
 */
export function phaseOf(state) {
  const p = PHASE[state];
  if (!p) throw new Error(`Unknown state: ${state}`);
  return p;
}

/**
 * Is this state one where the CUI must withhold every verdict?
 * @param {string} state
 */
export function isElicitOnly(state) {
  return ELICIT_ONLY.has(state);
}

/**
 * The agent may need the learner at any point while it is still working. The
 * CUI yields and remembers where it was, because competing for attention during
 * an approval prompt is the fastest way to get switched off (design goal 3).
 *
 * @param {string} state
 */
export function canPause(state) {
  return phaseOf(state) === 1 && state !== S.IDLE && state !== S.PAUSED;
}

/**
 * The learner can always leave. "skip" declines this run, "stop" ends the
 * session wherever it is.
 *
 * @param {string} state
 */
export function canExit(state) {
  return state !== S.END;
}
