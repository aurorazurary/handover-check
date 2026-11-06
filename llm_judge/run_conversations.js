/**
 * Produce the test conversations.
 *
 * A model plays the learner, using a persona prompt. Every CUI turn comes from
 * the running system: this script calls `begin()` and `step()`, the same
 * functions the web app calls. Nothing here writes a CUI line.
 *
 * Usage:
 *   npm run judge:conversations                 all twenty
 *   npm run judge:conversations -- --only=c03   one, for iterating
 *   npm run judge:conversations -- --turns=12
 *
 * Output: llm_judge/conversations/<id>.json
 *
 * @module llm_judge/run_conversations
 */

import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { begin, step, applyAgentEvent } from '../src/engine/controller.js';
import { createSession } from '../src/engine/session.js';
import { getScenario, publicView } from '../src/engine/scenarios.js';
import { complete, providerInfo } from '../src/llm/provider.js';
import { PLAN, getPersona } from './personas.js';
import { S } from '../src/engine/states.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'conversations');

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

const MAX_TURNS = Number(arg('turns', 14));

/**
 * Ask the persona model for the learner's next line.
 *
 * It is given the conversation so far and the context a real learner would
 * have on screen: what they asked the agent for and the repository listing.
 * It is never given the scenario secret, for the same reason the CUI is not:
 * a simulated learner who can see the diff is not simulating anything.
 *
 * @param {import('./personas.js').Persona} persona
 * @param {object} scenarioPublic
 * @param {Array<{role: string, content: string}>} transcript
 * @returns {Promise<string>}
 */
async function learnerTurn(persona, scenarioPublic, transcript) {
  const system = `${persona.prompt}

You are using a tool called Handover Check while a coding agent works on your
repository.

You asked the agent for: "${scenarioPublic.request}"

Your repository, before the change:
${scenarioPublic.repoMap.map((p) => `- ${p}`).join('\n')}

Reply with your next message only. No quotation marks, no stage directions, no
markdown.`;

  const messages = transcript.slice(-10).map((t) => ({
    // From the learner's point of view the CUI is the other party.
    role: /** @type {'user'|'assistant'} */ (t.role === 'cui' ? 'user' : 'assistant'),
    content: t.content,
  }));
  if (!messages.length || messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '(the tool has just opened)' });
  }

  const out = await complete({ system, messages, temperature: 0.9, maxTokens: 160 });
  return out.replace(/^["']|["']$/g, '').trim();
}

/**
 * Run one planned conversation end to end.
 *
 * @param {typeof PLAN[number]} plan
 */
async function runOne(plan) {
  const persona = getPersona(plan.persona);
  const session = createSession({
    scenarioId: plan.scenario,
    thresholdFiles: 3,
    writes: persona.writes,
    promptVersion: plan.promptVersion || 'v1',
    persist: false,
  });

  const scenarioPublic = publicView(getScenario(plan.scenario));
  const first = await begin(session);
  process.stdout.write(`  ${plan.id} ${plan.persona} / ${plan.scenario}`);

  let interrupted = false;

  for (let i = 0; i < MAX_TURNS; i += 1) {
    if (session.state === S.END) break;

    // The agent asks for an approval once, partway through Phase 1, so that
    // every conversation exercises the pause (design goal 3).
    if (!interrupted && i === 2 && session.phase === 1) {
      interrupted = true;
      applyAgentEvent(session, { type: 'approval', command: 'npm install nodemailer' });
      applyAgentEvent(session, { type: 'resume' });
    }

    if (session.state === S.WAIT_FOR_AGENT) {
      await step(session, '');
      continue;
    }

    const line = await learnerTurn(persona, scenarioPublic, session.transcript);
    const out = await step(session, line);
    if (out.done) break;
  }

  process.stdout.write(` -> ${session.transcript.length} turns, state ${session.state}\n`);

  return {
    id: plan.id,
    persona: plan.persona,
    personaLabel: persona.label,
    adversarial: !!persona.adversarial,
    scenario: plan.scenario,
    promptVersion: plan.promptVersion || 'v1',
    expectFail: !!plan.expectFail,
    note: plan.note,
    model: providerInfo().model,
    generatedAt: new Date().toISOString(),
    finalState: session.state,
    progress: session.progress,
    violations: session.violations,
    fileScore: session.reconcile.fileScore,
    transcript: session.transcript.map((t) => ({
      role: t.role, state: t.state, content: t.content,
    })),
  };
}

async function main() {
  if (!providerInfo().live) {
    console.error('Refusing to run: HC_PROVIDER is mock, so the CUI turns would be canned.');
    console.error('Set ANTHROPIC_API_KEY in .env and leave HC_PROVIDER=anthropic.');
    process.exit(1);
  }

  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
  const only = arg('only', null);
  const plans = only ? PLAN.filter((p) => p.id === only) : PLAN;
  if (!plans.length) {
    console.error(`No conversation matches --only=${only}`);
    process.exit(1);
  }

  console.log(`\nGenerating ${plans.length} conversation(s) with ${providerInfo().model}\n`);

  for (const plan of plans) {
    try {
      const convo = await runOne(plan);
      writeFileSync(join(OUT, `${plan.id}.json`), JSON.stringify(convo, null, 2), 'utf8');
    } catch (err) {
      console.error(`  ${plan.id} FAILED: ${err.message}`);
    }
  }

  console.log(`\nWritten to llm_judge/conversations/\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
