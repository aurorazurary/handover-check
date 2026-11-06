/**
 * Scenario loading and the public/secret boundary.
 *
 * Every scenario file is split into `public` and `secret` (see
 * scenarios/SCHEMA.md). This module is the only place that reads the secret
 * half off disk, and it exposes two different views of a scenario so that no
 * caller can hand the hidden plan to a model or a browser by accident:
 *
 *   publicView(s)   safe to send anywhere, at any time
 *   secretView(s)   only obtainable by passing a session already in Phase 2
 *
 * `secretView` throws if the session has not reached reconciliation. That is a
 * deliberate fail-loud: a bug that would leak the answer early stops the
 * request rather than quietly producing a worse learning interaction.
 *
 * @module engine/scenarios
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIO_DIR = join(HERE, '..', '..', 'scenarios');

/** @typedef {import('./types.js').Scenario} Scenario */

/** @type {Map<string, Scenario>} */
const cache = new Map();

/**
 * Load every scenario in scenarios/. Called once at startup; there is no
 * registry to keep in step, dropping a file in is enough.
 *
 * @returns {Scenario[]}
 */
export function loadScenarios() {
  if (cache.size) return [...cache.values()];

  const files = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const raw = readFileSync(join(SCENARIO_DIR, file), 'utf8');
    /** @type {Scenario} */
    const scenario = JSON.parse(raw);
    validate(scenario, file);
    cache.set(scenario.id, scenario);
  }
  return [...cache.values()];
}

/**
 * @param {string} id
 * @returns {Scenario}
 */
export function getScenario(id) {
  if (!cache.size) loadScenarios();
  const s = cache.get(id);
  if (!s) throw new Error(`Unknown scenario: ${id}`);
  return s;
}

/**
 * Everything a learner may see from the moment the session starts: what they
 * asked for, how the repo is laid out, and how big the plan is (a count, not
 * the contents).
 *
 * @param {Scenario} s
 * @returns {object}
 */
export function publicView(s) {
  return {
    id: s.id,
    title: s.title,
    stack: s.stack,
    planFileCount: s.planFileCount,
    estimatedAgentRunSeconds: s.estimatedAgentRunSeconds,
    request: s.public.request,
    conventions: s.public.conventions,
    repoMap: s.public.repoMap,
  };
}

/**
 * The hidden half. Guarded by the session's phase so that the boundary cannot
 * be crossed by calling the wrong function.
 *
 * @param {Scenario} s
 * @param {{phase: 1|2}} session
 * @returns {Scenario['secret']}
 * @throws {Error} if the session is still in Phase 1
 */
export function secretView(s, session) {
  if (session.phase !== 2) {
    throw new Error(
      `Refusing to read scenario secret in phase ${session.phase}. `
      + 'The plan and diff are only available once the agent has finished.',
    );
  }
  return s.secret;
}

/**
 * Structural checks that catch an inconsistent scenario at startup rather than
 * halfway through a demo. Run again by test/scenarios.test.js.
 *
 * @param {Scenario} s
 * @param {string} file
 */
export function validate(s, file = s.id) {
  const fail = (msg) => { throw new Error(`${file}: ${msg}`); };

  for (const k of ['id', 'title', 'stack', 'planFileCount', 'public', 'secret']) {
    if (s[k] === undefined) fail(`missing "${k}"`);
  }
  for (const k of ['request', 'conventions', 'repoMap']) {
    if (!s.public?.[k]) fail(`missing "public.${k}"`);
  }
  for (const k of ['plan', 'changes', 'dataPath', 'mechanismKeyPoints', 'concepts', 'finalCheck']) {
    if (!s.secret?.[k]) fail(`missing "secret.${k}"`);
  }

  if (s.planFileCount !== s.secret.plan.files.length) {
    fail(`planFileCount is ${s.planFileCount} but secret.plan.files has ${s.secret.plan.files.length}`);
  }

  const changed = new Set(s.secret.changes.map((c) => c.path));
  for (const p of s.secret.plan.files) {
    if (!changed.has(p)) fail(`planned file "${p}" is not in secret.changes`);
  }
  for (const c of s.secret.changes) {
    if (!c.role) fail(`change "${c.path}" has no role`);
    if (typeof c.inPlan !== 'boolean') fail(`change "${c.path}" has no inPlan flag`);
    if (c.inPlan && !s.secret.plan.files.includes(c.path)) {
      fail(`change "${c.path}" is marked inPlan but is not in the plan`);
    }
  }
  if (!s.secret.changes.some((c) => !c.inPlan)) {
    fail('expected at least one unplanned change; the reveal in Phase 2 depends on it');
  }
  if (!changed.has(s.secret.finalCheck.answerPath)) {
    fail(`finalCheck.answerPath "${s.secret.finalCheck.answerPath}" did not change`);
  }

  // The repo map describes the tree BEFORE the change, so a file the agent
  // added must not already be in it.
  for (const c of s.secret.changes) {
    const inMap = s.public.repoMap.includes(c.path);
    if (c.status === 'added' && inMap) fail(`"${c.path}" is marked added but is already in repoMap`);
    if (c.status === 'modified' && !inMap) fail(`"${c.path}" is marked modified but is not in repoMap`);
  }
}
