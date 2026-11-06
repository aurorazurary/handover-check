# Step 1: Build the core interaction

> Draft. Rewrite the reasoning in your own words; keep the tables and file
> references. Target ~700 words.

---

## 1.1 What I built

I built the whole two-phase interaction from Assignment 1, for three recorded
agent runs, with a browser front end and a terminal one over the same engine.

**Built:**

| Part | Design goal | Where |
|---|---|---|
| Phase 1 prediction: files, then mechanism, with no verdicts | DG1 | `engine/controller.js`, states `PREDICT_FILES`, `PREDICT_MECHANISM` |
| Deterministic phrase-to-path matching with ambiguity repair | DG1 | `engine/matcher.js` |
| Threshold gating and the agent-interrupt pause | DG3 | `controller.begin()`, `applyAgentEvent()` |
| Phase 2 reconciliation: score, reveal only the gap, show the lines | DG1 | `RECONCILE_FILES`, `RECONCILE_MECHANISM` |
| Prerequisite check before explaining a concept, pitched to the answer | DG2 | `ENTRY[GROUND]` and the `GROUND` handler |
| Final check on a change not yet discussed | learning goal | `FINAL_CHECK` |
| Handover card from recorded facts | progress tracking | `session.buildCard()` |
| Read-only guarantee | DG4 | no write path exists; `secretView()` throws outside Phase 2 |
| Voice input and spoken prompts, optional | modality argument from A1 | `public/index.html` |

**Left out:**

| Not built | Why | What is lost |
|---|---|---|
| A live hook into a real coding agent | A hook is tool-specific, and the judge tests need reproducible runs. Scenarios are recorded runs instead. | The claim that the check fits inside real agent run time is asserted, not measured. DG3 is demonstrated rather than evidenced. |
| Persistent progress across sessions | Each session stands alone; the card is the artefact. | No claim about learning over time. The user study in Step 3 is designed to measure that instead. |
| Multi-feature sessions | One feature per run. | Nothing: the A1 design was always one core interaction. |

**Why this is enough to test the design goals.** The three goals the testing
turns on are DG1 (elicit before explaining), DG2 (ground before explaining) and
DG4 (read-only, declared). All three are exercised by every run. DG3 is the
weakest, because the agent is simulated, so I have built the parts of it that
are decidable without a real agent (the threshold and the pause) and I do not
claim the rest.

## 1.2 Changes from Assignment 1

**The grader's question drove the biggest change.** The Assignment 1 feedback
asked whether the agent's plan is hidden from the learner and how that keeps the
prediction meaningful. In Assignment 1 I had not answered it. The prototype
showed the agent's plan in the left panel, which would have made "which files
will change?" a copying exercise.

The answer I built is a split in the data, not a rule in a prompt. A scenario
divides into `public` (the learner's request, the repository file tree, the
conventions) and `secret` (the plan, the diff, the concepts, the final check).
`buildPhase1Context()` reads the public half only, so during prediction the
model is never given the plan. It cannot disclose it early because it does not
hold it. `secretView()` throws if it is called before the agent has finished.

The line between the two halves follows what the learner could legitimately know
at that moment. They can see their own repository, because in real life they
could open it. They cannot see the diff, because in real life it does not exist
yet. The agent's plan sits on the hidden side because reading it would replace
prediction with transcription.

The running system shows the agent's progress as a count of files written, never
as paths.

**Three smaller changes, each forced by building it:**

1. *Ambiguity is resolved by asking, not by a model.* "The auth file on the
   server" fits two files in the password-reset repo. The first version let the
   model pick. It now returns the candidates as options, which is the repair
   strategy learners prefer (Ashktorab et al., 2019) and which should not vary
   run to run.

2. *Unrequested changes are scored separately from misses.* The agent adds a
   file nobody asked for in every scenario. Counting that as a failed prediction
   punishes the learner for not being psychic, so it is reported as a disclosure
   with its own category.

3. *States that open with a question ask it on entry.* Found by driving the
   interaction through the HTTP API: `GROUND` and `FINAL_CHECK` asked their
   question one turn late, so the learner was answering a question they had not
   been shown. Fixed in commit `4852ce3`.

## 1.3 How it works

[Insert `docs/architecture.png`.]

**One learner message, traced.** A learner in Phase 1 types *"the auth
controller and probably the user model"*.

1. `POST /api/session/:id/message` — `src/server/index.js`. Finds the session,
   calls `step()`. The route never reads `scenario.secret`.
2. `step()` — `engine/controller.js`. Records the turn, then calls
   `classifyLearnerTurn()` **before anything else**.
3. `classifyLearnerTurn()` — `engine/guardrails.js`. Returns `exit`,
   `answerDemand`, `promptExtraction` and `attemptLevel`. The attempt level is
   computed after stripping any demand, so "just tell me, but I think it's the
   controller" still counts as a try.
4. Four interrupt branches run in order (stop, skip, probe, demand-without-
   attempt). A demand climbs `hintLadder()` and the state does not advance.
   This message falls through all four.
5. `HANDLERS[PREDICT_FILES]` — `controller.js`. Calls
   `resolveAgainstRepo(input, scenario.public.repoMap)` in `engine/matcher.js`,
   which sees the public repo map and nothing else. `deriveAliases()` turns each
   path into the phrasings a learner would actually use; `normalise()` splits
   camelCase before lowercasing so a typed `authController` and a dictated "auth
   controller" become the same string.
6. The prediction is stored and `recordProgress(session, 'files', ...)` writes
   `unaided` or `hinted`, first write wins.
7. `buildPhase1Context()` — `engine/context.js`. **The boundary.** Throws if the
   state is Phase 2; calls `publicView()`; renders
   `prompts/v1/phase1_elicit.md`; `fill()` throws on any unfilled placeholder;
   `assertNoSecret()` scans the finished prompt.
8. `say()` — `controller.js`. Calls `provider.complete()`, the only model call
   in the system, then `scanReply()`. A Phase 1 reply containing an added path
   or a diff line is replaced wholesale and the violation is recorded.
9. The handler returns a transition, so `runEntryActions()` appends the next
   state's opening line.
10. `save()`, then the response: the reply plus whatever `uiFor()` permits. In
    Phase 1 that carries no file list, so the browser cannot render what it was
    never sent.

**The division that makes this testable.** The controller decides what kind of
turn this is; the model decides how to word it. "Never reveal before the diff
exists" is therefore a property of which branch runs, not of how persuasive a
prompt was, and it can be tested by a string check rather than by an opinion.
