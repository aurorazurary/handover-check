/**
 * The dialogue controller: one learner message in, one reply out.
 *
 * The controller decides *what kind of turn* this is. The model decides *how to
 * word it*. That division is the whole architecture, and it is what makes the
 * design goals testable: "never reveal before the diff exists" is a property of
 * which branch runs, not of how persuasive a prompt was.
 *
 * Reading order for a single message:
 *
 *   step()                 entry point
 *    -> classifyLearnerTurn()      guardrails.js   is this an exit, a demand,
 *                                                  a probe, or an attempt?
 *    -> HANDLERS[state]()          this file       what does that mean here?
 *    -> buildPhase1/2Context()     context.js      assemble the prompt, with or
 *                                                  without the secret
 *    -> say()                      this file       call the model, scan the
 *                                                  reply, swap it if it leaks
 *    -> recordProgress()           session.js      store what was observed
 *
 * @module engine/controller
 */

import { S, NEXT, phaseOf, isElicitOnly, canPause } from './states.js';
import { getScenario, publicView } from './scenarios.js';
import { resolveAgainstRepo, scorePrediction } from './matcher.js';
import { buildPhase1Context, buildPhase2Context, hunkText } from './context.js';
import {
  classifyLearnerTurn, scanReply, safeFallback, hintLadder, promptExtractionReply,
  endOnStatement,
} from './guardrails.js';
import {
  addTurn, recordProgress, nextHintRung, recordViolation, save, buildCard,
} from './session.js';
import { complete, completeJSON } from '../llm/provider.js';
import { render } from '../llm/prompts.js';

/**
 * Ask the model for a reply, then refuse to pass it on if it broke a rule.
 *
 * The fallback is deliberately in character. If a guardrail produced a visibly
 * different voice, a learner probing for the seam would find it immediately.
 *
 * @param {import('./types.js').Session} session
 * @param {import('./types.js').Scenario} scenario
 * @param {{system: string, messages: Array<{role: string, content: string}>}} ctx
 * @returns {Promise<string>}
 */
async function say(session, scenario, ctx) {
  const raw = await complete({ system: ctx.system, messages: ctx.messages });
  const scan = scanReply(raw, { state: session.state, scenario, session });

  if (!scan.ok) {
    for (const v of scan.violations) recordViolation(session, v);
    return safeFallback(session.state);
  }
  return raw;
}

/** Short restatement of the learner's own last answer, for the model to build on. */
function lastLearnerTurn(session) {
  const t = [...session.transcript].reverse().find((x) => x.role === 'learner');
  return t ? t.content : '';
}

/**
 * Open the session. Returns the offer, or declines to open at all if the plan
 * is below the learner's threshold, which is design goal 3: a check that fires
 * on every small change is a check that gets switched off.
 *
 * @param {import('./types.js').Session} session
 * @returns {Promise<{session: object, reply: string, ui: object}>}
 */
export async function begin(session) {
  const scenario = getScenario(session.scenarioId);
  const pub = publicView(scenario);

  if (pub.planFileCount < session.settings.thresholdFiles) {
    session.state = S.END;
    session.phase = 2;
    const reply = `The agent is making a small change, ${pub.planFileCount} files, which is under your threshold of ${session.settings.thresholdFiles}. I will stay out of it.`;
    addTurn(session, 'cui', reply);
    recordProgress(session, 'files', 'skipped');
    save(session);
    return { session, reply, ui: { belowThreshold: true } };
  }

  session.state = S.ACTIVATE;
  const reply = `This one is above your threshold, ${pub.planFileCount} files. Two questions while it works, then I will leave you alone until it is done. I will not tell you whether you are right yet.\n\nWant to predict, or skip this one?`;
  addTurn(session, 'cui', reply);
  save(session);

  return {
    session,
    reply,
    ui: { phase: 1, state: session.state, agent: session.agent, scenario: pub },
  };
}

/**
 * One turn.
 *
 * @param {import('./types.js').Session} session
 * @param {string} input what the learner typed or said
 * @returns {Promise<{session: object, reply: string, ui: object, done: boolean}>}
 */
export async function step(session, input) {
  const scenario = getScenario(session.scenarioId);
  // An empty input is not an utterance. It is how the UI advances the session
  // when the simulated agent finishes, so it is not recorded as a learner turn.
  if (input !== '') addTurn(session, 'learner', input);

  const turn = classifyLearnerTurn(input);

  // --- interrupts that are legal almost everywhere ---------------------------

  if (turn.exit === 'stop') {
    session.state = S.END;
    session.phase = 2;
    const reply = 'Stopped. Nothing in the code was changed.';
    addTurn(session, 'cui', reply);
    save(session);
    return { session, reply, ui: uiFor(session, scenario), done: true };
  }

  if (turn.exit === 'skip' && phaseOf(session.state) === 1) {
    session.state = S.END;
    session.phase = 2;
    recordProgress(session, 'files', 'skipped');
    const reply = 'Skipped. I will be back on the next large change unless you turn me off.';
    addTurn(session, 'cui', reply);
    save(session);
    return { session, reply, ui: uiFor(session, scenario), done: true };
  }

  if (turn.promptExtraction) {
    const reply = promptExtractionReply(session.state);
    recordViolation(session, { rule: 'G2', kind: 'attempted-extraction', blocked: true });
    addTurn(session, 'cui', reply);
    save(session);
    return { session, reply, ui: uiFor(session, scenario), done: false };
  }

  // An answer demand with nothing attached goes to the hint ladder and the
  // state does not advance. With an attempt attached it falls through, because
  // the learner did the work even though they also complained about it.
  if (turn.answerDemand && turn.attemptLevel < 2) {
    const kind = session.state === S.PREDICT_FILES ? 'files'
      : session.state === S.FINAL_CHECK ? 'final' : 'mechanism';
    const reply = hintLadder(nextHintRung(session), kind);
    markHinted(session);
    addTurn(session, 'cui', reply);
    save(session);
    return { session, reply, ui: uiFor(session, scenario), done: false };
  }

  // --- normal flow -----------------------------------------------------------

  // While the agent waits for approval the CUI has nothing to say: the
  // learner's attention belongs to the agent (DG3). There is no handler for
  // PAUSED, and a message here used to fall through to "We are done here"
  // and end the run. Found by clicking through the file picker in a browser.
  if (session.state === S.PAUSED) {
    const reply = 'The agent is waiting for you to allow or deny its command, on the left. '
      + 'Answer that first, then send this again and I will pick it up.';
    addTurn(session, 'cui', reply);
    save(session);
    return { session, reply, ui: uiFor(session, scenario), done: false };
  }

  const handler = HANDLERS[session.state];
  if (!handler) {
    const reply = 'We are done here. Start a new run when the agent next makes a large change.';
    addTurn(session, 'cui', reply);
    return { session, reply, ui: uiFor(session, scenario), done: true };
  }

  const out = await handler({ session, scenario, input, turn });

  let reply = out.reply;
  let extraUi = out.ui || {};

  if (out.next) {
    session.state = out.next;
    session.phase = phaseOf(out.next);
    session.sub = 0;
    // Some states open by asking something. That question belongs in this
    // reply, not in the next one: otherwise the learner answers a question
    // they have not been asked yet.
    const entered = await runEntryActions(session, scenario);
    if (entered.text) {
      // The system is about to speak again in this same message, so whatever
      // the handler said must not leave a question hanging: see endOnStatement.
      const closed = endOnStatement(reply, { fallback: out.ensure ? out.ensure.line : '' });
      if (closed.stripped.length) {
        recordViolation(session, {
          rule: 'QUALITY', kind: 'stacked-question', blocked: true, dropped: closed.stripped,
        });
      }
      reply = closed.text;
      if (out.ensure && !mentionsPath(reply, out.ensure.needle)) {
        reply = reply ? `${reply} ${out.ensure.line}` : out.ensure.line;
      }
      reply = reply ? `${reply}\n\n${entered.text}` : entered.text;
    }
    extraUi = { ...extraUi, ...entered.ui };
  } else {
    session.sub += 1;
  }

  addTurn(session, 'cui', reply);
  save(session);

  return {
    session,
    reply,
    ui: { ...uiFor(session, scenario), ...extraUi },
    done: session.state === S.END,
  };
}

/** Whether a reply names a file, by full path or by file name. */
function mentionsPath(reply, path) {
  const r = String(reply).toLowerCase();
  const p = String(path).toLowerCase();
  return r.includes(p) || r.includes(p.split('/').pop());
}

/** Mark the current learning item as having needed a hint. */
function markHinted(session) {
  const item = session.state === S.PREDICT_FILES ? 'files'
    : session.state === S.PREDICT_MECHANISM || session.state === S.RECONCILE_MECHANISM ? 'mechanism'
      : session.state === S.GROUND ? 'concept'
        : session.state === S.FINAL_CHECK ? 'finalCheck' : null;
  if (item) recordProgress(session, item, 'hinted');
}

/**
 * Entry actions: what a state says the moment it is entered, before the
 * learner has said anything in it.
 *
 * Without these, a state whose first job is to ask a question would have to
 * wait for a learner message to ask it, and the learner would be answering the
 * previous question while reading the next one. Chaining is capped so a
 * mistake in a scenario cannot loop.
 *
 * @type {Record<string, (a: {session: object, scenario: object}) => Promise<{text: string, next?: string, ui?: object}>>}
 */
const ENTRY = {
  /** Ask the prerequisite before explaining the unrequested file (DG2). */
  async [S.GROUND]({ session, scenario }) {
    const concept = scenario.secret.concepts[0];
    const unplanned = scenario.secret.changes.find((c) => !c.inPlan);
    session.sub = 1;
    return {
      text: `Now ${unplanned.path}, the one that was not in the plan. ${concept.prereqQuestion}`,
      ui: { concept: concept.id },
    };
  },

  /** Ask the transfer question. */
  async [S.FINAL_CHECK]({ scenario, session }) {
    session.sub = 1;
    return { text: scenario.secret.finalCheck.question };
  },

  /** The card is assembled from recorded facts, not generated, then we are done. */
  async [S.CARD]({ session, scenario }) {
    const card = buildCard(session, scenario);
    const lines = [
      `${card.feature}`,
      `Files: ${card.files ? `${card.files.total} changed, you predicted ${card.files.predicted} of the ${card.files.planned} that were planned` : 'not scored'}`,
      `Mechanism: ${card.mechanism ?? 'not reached'}`,
      `Concept: ${card.concept ?? 'not reached'}`,
      `Can modify: ${card.canModify ?? 'not reached'}`,
      ...card.unrequested.map((u) => `Unrequested: ${u.path}, kept for you to decide`),
      '',
      'Say tomorrow:',
      ...card.sayTomorrow.map((x) => `- ${x}`),
      '',
      'Nothing in the code was changed.',
    ];
    return { text: lines.join('\n'), next: S.END, ui: { card } };
  },
};

/**
 * Run entry actions for the state just entered, following any chain.
 *
 * @param {object} session
 * @param {object} scenario
 * @returns {Promise<{text: string, ui: object}>}
 */
async function runEntryActions(session, scenario) {
  let text = '';
  let ui = {};
  for (let guard = 0; guard < 3; guard += 1) {
    const entry = ENTRY[session.state];
    if (!entry) break;
    const e = await entry({ session, scenario });
    text = text ? `${text}\n\n${e.text}` : e.text;
    ui = { ...ui, ...(e.ui || {}) };
    if (!e.next) break;
    session.state = e.next;
    session.phase = phaseOf(e.next);
    session.sub = 0;
  }
  return { text, ui };
}

// ---------------------------------------------------------------------------
// State handlers
// ---------------------------------------------------------------------------

/** @type {Record<string, (a: any) => Promise<{reply: string, next?: string, ui?: object}>>} */
const HANDLERS = {

  /** The learner has been offered the check and is answering yes or no. */
  async [S.ACTIVATE]({ session, scenario }) {
    const ctx = buildPhase1Context({
      session,
      scenario,
      turnGoal: 'Ask the first question: which files do they think the agent will touch, '
        + 'and what will each one do. One sentence of framing at most, then the question.',
    });
    return { reply: await say(session, scenario, ctx), next: S.PREDICT_FILES };
  },

  /**
   * Prediction of the file list. Nothing here is scored: the diff does not
   * exist yet. The only processing is resolving the phrases they used against
   * the repo as it stands, which can produce an ambiguity to clear up.
   */
  async [S.PREDICT_FILES]({ session, scenario, input, turn }) {
    const resolved = resolveAgainstRepo(input, scenario.public.repoMap);

    // Ambiguity is handled deterministically rather than by the model: offering
    // the candidates is the repair learners prefer, and it must not be left to
    // chance (Ashktorab et al., CHI 2019).
    if (resolved.ambiguous.length && !session.pendingDisambiguation) {
      const a = resolved.ambiguous[0];
      session.pendingDisambiguation = a;
      session.prediction.files = { text: input, resolved: resolved.resolved, ambiguous: resolved.ambiguous };
      return {
        reply: `Two files match "${a.term}": ${a.candidates.join(' or ')}. Which did you mean, or both?`,
        ui: { options: a.candidates },
      };
    }

    let effort = turn.attemptLevel;

    if (session.pendingDisambiguation) {
      // Fold the clarification into the stored prediction and carry on. The
      // clarification itself is usually one word ("both"), but the learner has
      // already made their attempt, so it is judged on the merged text.
      const pending = session.pendingDisambiguation;
      const chosen = pending.candidates.filter(
        (c) => /\bboth|all\b/i.test(input) || resolveAgainstRepo(input, [c]).resolved.length,
      );
      const merged = `${session.prediction.files.text} ${input}`;
      const again = resolveAgainstRepo(merged, scenario.public.repoMap);
      session.prediction.files = {
        text: merged,
        resolved: [...new Set([...again.resolved, ...chosen])],
        ambiguous: [],
      };
      session.pendingDisambiguation = null;
      effort = classifyLearnerTurn(merged).attemptLevel;
    } else {
      session.prediction.files = { text: input, resolved: resolved.resolved, ambiguous: [] };
    }

    if (effort === 0) {
      markHinted(session);
      return { reply: hintLadder(nextHintRung(session), 'files') };
    }

    recordProgress(session, 'files', effort === 2 ? 'unaided' : 'hinted');

    const ctx = buildPhase1Context({
      session,
      scenario,
      turnGoal: 'Acknowledge that you have recorded their answer, in a few words, without '
        + 'evaluating it. Then ask the second question: forget files, what should happen '
        + 'step by step from the moment the user acts until the feature has done its job.',
      priorContext: `They have just predicted: "${lastLearnerTurn(session)}"`,
    });
    return { reply: await say(session, scenario, ctx), next: S.PREDICT_MECHANISM };
  },

  /** Prediction of the mechanism. Still no verdict. */
  async [S.PREDICT_MECHANISM]({ session, scenario, input, turn }) {
    session.prediction.mechanism = { text: input, grade: null };

    if (turn.attemptLevel === 0) {
      markHinted(session);
      return { reply: hintLadder(nextHintRung(session), 'mechanism') };
    }

    const ctx = buildPhase1Context({
      session,
      scenario,
      turnGoal: 'Acknowledge in a few words. Then leave them one question to think about '
        + 'while the agent finishes, and say explicitly that they should not answer it now. '
        + 'Pick something whose answer is a detail they did not mention.',
      priorContext: `They have just described the mechanism as: "${input}"`,
    });
    return { reply: await say(session, scenario, ctx), next: S.WAIT_FOR_AGENT };
  },

  /**
   * Waiting. In the running system the UI advances this when the simulated
   * agent finishes; a typed message here just moves it along, which is what the
   * headless test harness does.
   */
  async [S.WAIT_FOR_AGENT]({ session, scenario }) {
    session.agent.status = 'done';
    session.phase = 2;
    session.state = S.RECONCILE_FILES;
    return HANDLERS[S.RECONCILE_FILES]({ session, scenario, input: '', turn: { attemptLevel: 2 } });
  },

  /**
   * First Phase 2 turn. The file score is computed deterministically here, and
   * the model is given the result to phrase rather than the diff to summarise.
   */
  async [S.RECONCILE_FILES]({ session, scenario }) {
    const secret = scenario.secret;
    const score = scorePrediction(
      session.prediction.files || { text: '' },
      secret.changes,
      scenario.public.repoMap,
    );
    session.reconcile.fileScore = score;

    const unplanned = secret.changes.filter((c) => !c.inPlan);
    const missedPlanned = score.missed;

    const gapLines = [];
    if (missedPlanned.length) {
      gapLines.push('They did not name these, which were in the plan:');
      for (const p of missedPlanned) {
        const c = secret.changes.find((x) => x.path === p);
        gapLines.push(`- ${p}: ${c.role}`);
      }
    }
    for (const c of unplanned) {
      // Deliberately withholding c.role here. Naming the file is the news; what
      // it does belongs in GROUND, after the prerequisite has been checked.
      // Supplying the role at this point produced a reply that explained the
      // file before asking whether the learner knew the concept behind it.
      gapLines.push(`- ${c.path} was NOT in the plan. The agent added it during execution. `
        + 'Name it and say you will come back to it. Do NOT say what it does yet.');
    }
    if (score.spurious.length) {
      gapLines.push(`They named these, which did not change: ${score.spurious.join(', ')}`);
    }

    const ctx = buildPhase2Context({
      session,
      scenario,
      predictionSummary: session.prediction.files?.text || '(no prediction)',
      actualSummary: secret.changes.map((c) => `- ${c.path}${c.inPlan ? '' : '  [not in plan]'}`).join('\n'),
      gap: gapLines.join('\n') || 'They named every file. There is nothing to add here.',
      turnGoal: `Tell them the score in one line: they named ${score.score.predicted} of the `
        + `${score.score.total} files that were planned. Then cover only the gap above. `
        + 'Do not walk through the files they got right. End by asking them to explain, in '
        + 'their own words, how the feature works end to end.',
    });

    return {
      reply: await say(session, scenario, ctx),
      next: S.RECONCILE_MECHANISM,
      ui: { fileScore: score, files: secret.changes.map((c) => ({ path: c.path, inPlan: c.inPlan })) },
    };
  },

  /**
   * Grade the mechanism explanation against the scenario's key points, then
   * reveal only the points that are missing.
   */
  async [S.RECONCILE_MECHANISM]({ session, scenario, input, turn }) {
    const secret = scenario.secret;

    if (turn.attemptLevel === 0) {
      markHinted(session);
      return { reply: hintLadder(nextHintRung(session), 'mechanism') };
    }

    const grade = await completeJSON({
      system: render('grade_mechanism', {
        QUESTION: 'How does this feature work, end to end?',
        ANSWER: input,
        KEY_POINTS: secret.mechanismKeyPoints
          .map((p) => `- ${p.id}: ${p.statement} (why it matters: ${p.why})`).join('\n'),
      }),
      messages: [{ role: 'user', content: 'Grade it.' }],
      maxTokens: 5000,
      // A failed grade used to count as partial credit, and the turn then told
      // the learner their steps matched. The red team's R2-multiturn run sent
      // "list them as bullet points"; the grader rightly refused to grade that,
      // and the system replied "Your steps line up well". Fail closed instead.
      fallback: { level: 'none', points: [], contradicted: [], firstGap: secret.mechanismKeyPoints[0].id, evidence: '' },
    });
    if (grade._fallback) recordViolation(session, { rule: 'QUALITY', kind: 'grade-fallback' });

    session.prediction.mechanism = { text: input, grade };
    recordProgress(
      session,
      'mechanism',
      grade.level === 'full' ? 'unaided' : grade.level === 'none' ? 'revealed' : 'hinted',
    );

    const missing = secret.mechanismKeyPoints.filter(
      (p) => !grade.points?.find((g) => g.id === p.id && g.status !== 'missing'),
    );

    const gap = missing.length
      ? missing.map((p) => `- ${p.statement} (${p.why})`).join('\n')
        + '\n\nLines that show it:\n'
        + secret.changes
          .filter((c) => c.inPlan)
          .slice(0, 2)
          .map(hunkText)
          .join('\n')
      : 'Nothing is missing from their explanation.';

    const ctx = buildPhase2Context({
      session,
      scenario,
      predictionSummary: input,
      actualSummary: secret.dataPath.map((h) => `${h.from} -> ${h.to} (${h.via})`).join('\n'),
      gap,
      // Only claim their steps match when a real grade says some of them do.
      turnGoal: `${grade._fallback || grade.level === 'none'
        ? 'They have not given an explanation that can be checked. Do not say their steps '
          + 'match and do not say anything they said was right. Walk through the points above '
          + 'plainly, quoting at most four lines of the code that shows it.'
        : missing.length
          ? 'Say in one line which of their steps match what was built, correcting any that do '
            + 'not, then give only the points above that they did not say, quoting at most four '
            + 'lines of the code that shows it.'
          : 'Confirm briefly that the explanation is complete, and add one detail a maintainer '
            + 'would ask about. Do not repeat their explanation back to them.'
      } End on a statement, not a question: the next question is asked for you.`,
    });

    return { reply: await say(session, scenario, ctx), next: S.GROUND, ui: { grade } };
  },

  /**
   * Check the prerequisite concept before explaining it, and pitch the
   * explanation to what they say. Two sub-turns: ask, then explain.
   */
  async [S.GROUND]({ session, scenario, input, turn }) {
    const secret = scenario.secret;
    const concept = secret.concepts[0];

    // The prerequisite question was asked on entry. This turn is their answer.
    // Which explanation to use is decided here, not by the model, so that the
    // same answer always produces the same depth.
    const knows = turn.attemptLevel === 2 && !/\b(no|not really|never heard|nope)\b/i.test(input);
    const vague = turn.attemptLevel === 1 || /\bsort of|kind of|roughly|i think\b/i.test(input);

    recordProgress(session, 'concept', knows ? 'unaided' : vague ? 'hinted' : 'revealed');

    const chosen = knows ? concept.shortExplanation : concept.longExplanation;
    const analogy = !knows
      ? (concept.analogies[(session.settings.writes[0] || '').toLowerCase()] || concept.analogies.default || '')
      : '';
    const unplanned = secret.changes.find((c) => !c.inPlan);

    const ctx = buildPhase2Context({
      session,
      scenario,
      predictionSummary: session.prediction.files?.text || '',
      actualSummary: `${unplanned.path}: ${unplanned.role}`,
      gap: `Concept: ${concept.name}\nExplanation to use: ${chosen}\n${analogy ? `Analogy to use: ${analogy}\n` : ''}Code:\n${hunkText(unplanned)}`,
      turnGoal: `${knows
        ? 'They know the concept, so do not teach it. Say what this particular file does in '
          + 'one or two sentences, then say the decision to keep it or remove it is theirs '
          + 'and that you will not change any code.'
        : 'They do not know the concept well. Explain it using the explanation and the analogy '
          + 'given, in two or three sentences, then say what this file does and that whether '
          + 'to keep it is their decision. You change nothing.'
      } End on a statement, not a question: the next question is asked for you.`,
      priorContext: `They answered the prerequisite question with: "${input}"`,
    });

    return { reply: await say(session, scenario, ctx), next: S.FINAL_CHECK };
  },

  /**
   * One change they have not been shown, to see whether the understanding
   * transfers. Graded deterministically: either they name the file or they do
   * not.
   */
  async [S.FINAL_CHECK]({ session, scenario, input, turn }) {
    const fc = scenario.secret.finalCheck;

    // The question was asked on entry. This turn is their answer.
    const named = scorePrediction(
      { text: input },
      [{ path: fc.answerPath, inPlan: true }],
      scenario.public.repoMap,
    ).hit.length > 0;

    const distractor = (fc.distractors || []).find(
      (d) => scorePrediction({ text: input }, [{ path: d.path, inPlan: true }], []).hit.length > 0,
    );

    if (!named && turn.attemptLevel === 0) {
      markHinted(session);
      return { reply: hintLadder(nextHintRung(session), 'final') };
    }

    recordProgress(session, 'finalCheck', named ? (session.hintRung[S.FINAL_CHECK] ? 'hinted' : 'unaided') : 'revealed');

    const gap = named
      ? `Correct. The answer is ${fc.answerPath}, ${fc.answerDetail}.`
      : distractor
        ? `They said ${distractor.path}. That is wrong because: ${distractor.note}. The answer is ${fc.answerPath}, ${fc.answerDetail}.`
        : `They did not name it. The answer is ${fc.answerPath}, ${fc.answerDetail}.`;

    const ctx = buildPhase2Context({
      session,
      scenario,
      predictionSummary: input,
      actualSummary: `${fc.answerPath}: ${fc.answerDetail}`,
      gap,
      turnGoal: named
        ? 'Confirm in one line and name the exact line they would change. Do not elaborate.'
        : distractor
          ? 'Do not simply correct them. Ask the question that makes the distinction visible, '
            + 'then give the answer in one line.'
          : 'Give the answer in one line and say what distinguishes it from the file that '
            + 'merely stores the value.',
    });

    // The card follows straight after this reply and the session ends, so a
    // learner who missed it must leave with the answer, however the model
    // phrased things. c10 and c15 in the judge set ended on a question here.
    const ensure = named ? null : {
      needle: fc.answerPath,
      line: `The answer is ${fc.answerPath}, ${fc.answerDetail}.`,
    };

    return {
      reply: await say(session, scenario, ctx), next: S.CARD, ui: { finalCheck: { named } }, ensure,
    };
  },

};

/**
 * Agent events. The agent is simulated here, but the controller treats them
 * exactly as it would real ones: it yields while the agent needs the learner,
 * and resumes where it left off.
 *
 * @param {import('./types.js').Session} session
 * @param {{type: 'approval'|'resume'|'progress'|'done', command?: string, filesDone?: number}} event
 * @returns {{session: object, reply: string|null}}
 */
export function applyAgentEvent(session, event) {
  if (event.type === 'approval' && canPause(session.state)) {
    session.returnState = session.state;
    session.state = S.PAUSED;
    session.agent.status = 'waiting';
    session.agent.pendingApproval = event.command || 'a command';
    const reply = 'Agent needs you. I will wait.';
    addTurn(session, 'cui', reply);
    save(session);
    return { session, reply };
  }

  if (event.type === 'resume' && session.state === S.PAUSED) {
    session.state = session.returnState || S.PREDICT_FILES;
    session.returnState = null;
    session.agent.status = 'working';
    session.agent.pendingApproval = null;
    // "Nothing else from me" is only true once the learner has finished
    // predicting. If a question was still open when the agent paused, say it
    // again: the old line told a learner who had not yet answered the opening
    // question to wait, and the agent finished while they did.
    let reply = 'Back. Nothing else from me until it is done.';
    if (session.state !== S.WAIT_FOR_AGENT) {
      const prior = [...session.transcript].reverse()
        .find((t) => t.role === 'cui' && t.state === session.state);
      const open = prior ? endOnStatement(prior.content).stripped.join(' ') : '';
      reply = open
        ? `Back. Still over to you: ${open}`
        : 'Back. Carry on with your answer whenever you are ready.';
    }
    addTurn(session, 'cui', reply);
    save(session);
    return { session, reply };
  }

  if (event.type === 'progress') {
    session.agent.filesDone = event.filesDone ?? session.agent.filesDone;
    save(session);
    return { session, reply: null };
  }

  if (event.type === 'done') {
    session.agent.status = 'done';
    save(session);
    return { session, reply: null };
  }

  return { session, reply: null };
}

/**
 * The slice of state the browser needs. Phase 1 deliberately carries no file
 * list: the client cannot render what it was never sent.
 *
 * @param {import('./types.js').Session} session
 * @param {import('./types.js').Scenario} scenario
 */
export function uiFor(session, scenario) {
  const base = {
    sessionId: session.id,
    state: session.state,
    phase: session.phase,
    agent: session.agent,
    progress: session.progress,
    elicitOnly: isElicitOnly(session.state),
  };
  if (session.phase === 1) return base;
  return {
    ...base,
    files: scenario.secret.changes.map((c) => ({
      path: c.path, inPlan: c.inPlan, role: c.role, status: c.status,
    })),
    fileScore: session.reconcile.fileScore,
  };
}

export { NEXT };
