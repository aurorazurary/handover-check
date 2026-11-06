/**
 * Session state: what the learner did, not what a model inferred about them.
 *
 * The progress record stores observable facts (named five of six files; needed
 * one hint; could not name the concept) rather than a judgement of the learner.
 * That is a deliberate limit. A record of "seems to struggle with async" is a
 * claim the system cannot support and the learner cannot check, and it would
 * follow them into the next session.
 *
 * @module engine/session
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S } from './states.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', '..', 'data', 'sessions');

/** Default number of files in a plan below which the check stays silent. */
export const DEFAULT_THRESHOLD = 4;

/**
 * @param {object} [opts]
 * @param {string} [opts.scenarioId]
 * @param {number} [opts.thresholdFiles]
 * @param {string[]} [opts.writes] languages the learner writes without help
 * @param {string} [opts.promptVersion] pinned per session so the judge set can
 *   run the weakened v0 prompts against the same engine
 * @param {boolean} [opts.persist]
 * @returns {import('./types.js').Session}
 */
export function createSession({
  scenarioId = 'password-reset',
  thresholdFiles = DEFAULT_THRESHOLD,
  writes = ['Java', 'Python'],
  promptVersion = process.env.HC_PROMPT_VERSION || 'v1',
  persist = true,
} = {}) {
  return {
    id: randomUUID(),
    scenarioId,
    createdAt: new Date().toISOString(),
    persist,

    state: S.IDLE,
    phase: 1,
    sub: 0,
    returnState: null,

    settings: { thresholdFiles, writes, promptVersion },

    transcript: [],

    prediction: {
      files: null,      // {text, resolved, ambiguous}
      mechanism: null,  // {text, grade}
    },

    reconcile: {
      fileScore: null,
      gaps: [],         // queue of {kind, path?, pointId?, conceptId?}
      gapIndex: 0,
    },

    // Observable outcomes only. One of: 'unaided' | 'hinted' | 'revealed' | 'skipped'
    progress: {
      files: null,
      mechanism: null,
      concept: null,
      finalCheck: null,
    },

    hintRung: {},

    /** Guardrail trips, kept so red_team runs can assert on them. */
    violations: [],

    agent: {
      status: 'working',       // working | waiting | done
      filesDone: 0,
      pendingApproval: null,
    },
  };
}

/**
 * @param {import('./types.js').Session} s
 * @param {'learner'|'cui'|'system'} role
 * @param {string} content
 * @param {object} [meta]
 */
export function addTurn(s, role, content, meta = {}) {
  s.transcript.push({
    role,
    content,
    state: s.state,
    ts: new Date().toISOString(),
    ...meta,
  });
  return s;
}

/**
 * Record how a learning outcome was reached. Called once per item; the first
 * value wins, because being told the answer after two hints is "revealed",
 * not "unaided".
 *
 * @param {import('./types.js').Session} s
 * @param {'files'|'mechanism'|'concept'|'finalCheck'} item
 * @param {'unaided'|'hinted'|'revealed'|'skipped'} how
 */
export function recordProgress(s, item, how) {
  if (s.progress[item] === null) s.progress[item] = how;
  return s;
}

/**
 * Bump and read the hint ladder rung for the state we are in.
 * @param {import('./types.js').Session} s
 * @returns {number} the rung before incrementing
 */
export function nextHintRung(s) {
  const key = s.state;
  const current = s.hintRung[key] ?? 0;
  s.hintRung[key] = current + 1;
  return current;
}

/**
 * @param {import('./types.js').Session} s
 * @param {{rule: string, kind: string, needle?: string}} v
 */
export function recordViolation(s, v) {
  s.violations.push({ ...v, state: s.state, ts: new Date().toISOString() });
  return s;
}

/**
 * Persist to data/sessions/<id>.json. Sessions are files rather than rows so
 * that a transcript can be read, diffed and attached to a report without a
 * database.
 *
 * @param {import('./types.js').Session} s
 */
export function save(s) {
  if (!s.persist) return s;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, `${s.id}.json`), JSON.stringify(s, null, 2), 'utf8');
  return s;
}

/**
 * @param {string} id
 * @returns {import('./types.js').Session}
 */
export function load(id) {
  const path = join(DATA_DIR, `${id}.json`);
  if (!existsSync(path)) throw new Error(`No such session: ${id}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The handover card. Everything in it is a fact the session observed, which is
 * why it can be handed to someone else: the learner is not relying on the
 * system's opinion of them.
 *
 * @param {import('./types.js').Session} s
 * @param {import('./types.js').Scenario} scenario
 * @returns {object}
 */
export function buildCard(s, scenario) {
  const score = s.reconcile.fileScore;
  const unplanned = scenario.secret.changes.filter((c) => !c.inPlan);

  return {
    feature: scenario.title,
    stack: scenario.stack,
    files: score
      ? { total: scenario.secret.changes.length, predicted: score.score.predicted, planned: score.score.total }
      : null,
    mechanism: s.progress.mechanism,
    concept: s.progress.concept,
    canModify: s.progress.finalCheck,
    unrequested: unplanned.map((c) => ({ path: c.path, role: c.role })),
    sayTomorrow: scenario.secret.mechanismKeyPoints.slice(0, 2).map((p) => p.statement),
    codeChanged: false,
    generatedAt: new Date().toISOString(),
  };
}
