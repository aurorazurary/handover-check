/**
 * Terminal front end.
 *
 * It exists for two reasons. It is the quickest way to try a change to a
 * prompt, and it proves the engine is not entangled with the browser: the web
 * app and this file are two callers of the same `begin()` and `step()`.
 *
 * Usage:
 *   npm run chat                       password reset, default settings
 *   npm run chat -- --scenario=csv-export --threshold=2
 *   npm run chat -- --agent=manual     drive the agent events yourself
 *
 * In the conversation:
 *   /agent approve     simulate the coding agent asking to run a command
 *   /agent resume      you approved it
 *   /agent done        the agent has finished; moves into Phase 2
 *   /state             print the state, progress record and any violations
 *   /quit
 *
 * @module cli/chat
 */

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { begin, step, applyAgentEvent } from '../engine/controller.js';
import { createSession } from '../engine/session.js';
import { getScenario, publicView, loadScenarios } from '../engine/scenarios.js';
import { providerInfo } from '../llm/provider.js';
import { S } from '../engine/states.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

const C = {
  cui: (s) => `\x1b[38;5;180m${s}\x1b[0m`,
  me: (s) => `\x1b[38;5;174m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  warn: (s) => `\x1b[38;5;215m${s}\x1b[0m`,
};

async function main() {
  const scenarioId = arg('scenario', 'password-reset');
  const known = loadScenarios().map((s) => s.id);
  if (!known.includes(scenarioId)) {
    console.error(`Unknown scenario "${scenarioId}". Available: ${known.join(', ')}`);
    process.exit(1);
  }

  const session = createSession({
    scenarioId,
    thresholdFiles: Number(arg('threshold', 4)),
    writes: arg('writes', 'Java,Python').split(',').map((s) => s.trim()),
  });

  const scenario = getScenario(scenarioId);
  const pub = publicView(scenario);
  const info = providerInfo();

  console.log(C.dim(`\nprovider ${info.provider}  model ${info.model}`));
  if (!info.live) console.log(C.warn('canned replies: set ANTHROPIC_API_KEY in .env for real ones'));
  console.log(C.dim(`\nYou asked the agent:\n  "${pub.request}"`));
  console.log(C.dim(`It plans to touch ${pub.planFileCount} files. Your threshold is ${session.settings.thresholdFiles}.\n`));

  const rl = createInterface({ input: stdin, output: stdout });
  const show = (reply) => console.log(`\n${C.cui(reply)}\n`);

  const first = await begin(session);
  show(first.reply);

  // Unless --agent=manual, the agent finishes by itself once both predictions
  // are in, which is what the browser does on a timer.
  const autoAgent = arg('agent', 'auto') === 'auto';

  for (;;) {
    if (session.state === S.END) break;

    if (autoAgent && session.state === S.WAIT_FOR_AGENT) {
      console.log(C.dim('[the coding agent has finished]'));
      const out = await step(session, '');
      show(out.reply);
      continue;
    }

    const line = (await rl.question(C.me('you > '))).trim();

    if (line === '/quit') break;
    if (line === '/state') {
      console.log(C.dim(JSON.stringify({
        state: session.state,
        phase: session.phase,
        progress: session.progress,
        violations: session.violations,
      }, null, 2)));
      continue;
    }
    if (line.startsWith('/agent ')) {
      const type = line.split(' ')[1];
      const map = { approve: 'approval', resume: 'resume', done: 'done' };
      const out = applyAgentEvent(session, {
        type: map[type] || type,
        command: 'npm install nodemailer',
      });
      if (out.reply) show(out.reply);
      else console.log(C.dim(`[agent: ${type}]`));
      continue;
    }
    if (!line) continue;

    const out = await step(session, line);
    show(out.reply);
    if (out.done) break;
  }

  rl.close();
  console.log(C.dim(`\nsession ${session.id}`));
  console.log(C.dim(`progress  ${JSON.stringify(session.progress)}`));
  if (session.violations.length) {
    console.log(C.warn(`violations ${JSON.stringify(session.violations)}`));
  }
  console.log(C.dim(`saved to data/sessions/${session.id}.json\n`));
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exit(1);
});
