/**
 * HTTP layer. Thin on purpose: it holds sessions, routes requests to the
 * controller, and decides what the browser is allowed to see.
 *
 * The last of those is the part that matters. `uiFor()` in the controller
 * returns a Phase 1 view with no file list, and these routes never reach into
 * `scenario.secret` themselves. A bug in the client cannot reveal the plan,
 * because the plan was never sent.
 *
 * @module server/index
 */

import 'dotenv/config';
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { begin, step, applyAgentEvent, uiFor } from '../engine/controller.js';
import { createSession, save, load, buildCard } from '../engine/session.js';
import { loadScenarios, getScenario, publicView } from '../engine/scenarios.js';
import { providerInfo } from '../llm/provider.js';
import { endOnStatement } from '../engine/guardrails.js';
import { PROMPT_VERSION } from '../llm/prompts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(HERE, '..', '..', 'public')));

/**
 * Split a reply into what it says and what it asks, so the page can make the
 * question the learner has to answer impossible to miss. Reading the judge set
 * by hand, the question was often the last line of a long turn and the easiest
 * part to skim past.
 *
 * Replies end on at most one question (see endOnStatement in the controller),
 * so the trailing question is the one to answer. While the agent is still
 * working the system sometimes leaves a question to think about, not to
 * answer, and the page labels that differently.
 *
 * @param {string} reply
 * @param {string} state the state after this reply
 * @returns {{lead: string, question: string, kind: 'answer'|'ponder'}|null}
 */
function ask(reply, state) {
  if (!reply) return null;
  const { text, stripped } = endOnStatement(reply);
  if (!stripped.length) return null;
  return {
    lead: text,
    question: stripped.join(' '),
    kind: state === 'WAIT_FOR_AGENT' || state === 'PAUSED' ? 'ponder' : 'answer',
  };
}

/** In-memory index of live sessions; the durable copy is on disk. */
const live = new Map();

/** @param {string} id */
function getSession(id) {
  if (live.has(id)) return live.get(id);
  const s = load(id);          // throws if unknown
  live.set(id, s);
  return s;
}

/** Wrap an async route so a thrown error becomes a 500 with a message. */
const handle = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// --- metadata ---------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ...providerInfo(), promptVersion: PROMPT_VERSION });
});

app.get('/api/scenarios', (req, res) => {
  res.json(loadScenarios().map(publicView));
});

// --- a run ------------------------------------------------------------------

app.post('/api/session', handle(async (req, res) => {
  const { scenarioId, thresholdFiles, writes } = req.body || {};
  const session = createSession({ scenarioId, thresholdFiles, writes });
  live.set(session.id, session);

  const out = await begin(session);
  res.json({
    sessionId: session.id,
    reply: out.reply,
    ui: { ...out.ui, ask: ask(out.reply, session.state) },
    scenario: publicView(getScenario(session.scenarioId)),
  });
}));

app.post('/api/session/:id/message', handle(async (req, res) => {
  const session = getSession(req.params.id);
  const text = String(req.body?.text ?? '');
  // An empty body is the UI saying "the agent has finished, carry on". Any
  // other state treats it as an empty turn and hints.
  if (!text.trim() && session.state !== 'WAIT_FOR_AGENT') {
    return res.status(400).json({ error: 'Empty message' });
  }

  const out = await step(session, text);
  res.json({ reply: out.reply, ui: { ...out.ui, ask: out.done ? null : ask(out.reply, session.state) }, done: out.done });
}));

/**
 * Agent events. In this build the agent is simulated by the client's timer, but
 * the server treats the events exactly as it would real ones from a hook, so
 * swapping the simulation for a real agent is a change to who posts here.
 */
app.post('/api/session/:id/agent', handle(async (req, res) => {
  const session = getSession(req.params.id);
  const { type, command, filesDone } = req.body || {};
  const out = applyAgentEvent(session, { type, command, filesDone });
  res.json({
    reply: out.reply,
    ui: { ...uiFor(session, getScenario(session.scenarioId)), ask: ask(out.reply, session.state) },
  });
}));

app.get('/api/session/:id', handle(async (req, res) => {
  const session = getSession(req.params.id);
  res.json({ ui: uiFor(session, getScenario(session.scenarioId)) });
}));

/** The card, as data, so it can be saved or printed. */
app.get('/api/session/:id/card', handle(async (req, res) => {
  const session = getSession(req.params.id);
  if (session.phase !== 2) return res.status(409).json({ error: 'Session has not finished' });
  res.json(buildCard(session, getScenario(session.scenarioId)));
}));

/** The transcript, for attaching to a report. */
app.get('/api/session/:id/transcript', handle(async (req, res) => {
  const session = getSession(req.params.id);
  save(session);
  res.json({
    id: session.id,
    scenarioId: session.scenarioId,
    progress: session.progress,
    violations: session.violations,
    transcript: session.transcript,
  });
}));

const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    const info = providerInfo();
    console.log(`Handover Check on http://localhost:${PORT}`);
    console.log(`  provider: ${info.provider}  model: ${info.model}  prompts: ${PROMPT_VERSION}`);
    if (!info.live) {
      console.log('  running with canned replies. Set ANTHROPIC_API_KEY in .env for real ones.');
    }
  });
}

export default app;
