# Developer guide

For someone who has to change this, or explain it.

---

## 1. The shape of it

Three layers, and the rule that keeps them apart:

```
public/index.html  ·  src/cli/chat.js        two front ends
            |
src/server/index.js                          HTTP, holds sessions
            |
src/engine/*                                 the interaction. No HTTP, no DOM
            |
src/llm/provider.js                          the only module that calls a model
```

`src/engine` has no idea it is being used over HTTP. That is why `npm run chat`
exists: it is a second caller, and if the engine ever grows a dependency on the
browser, the CLI breaks first.

**The controller decides what kind of turn this is. The model decides how to
word it.** Everything load-bearing is a branch in `controller.js`, not a
sentence in a prompt. Guardrails that live in prompts are requests; guardrails
that live in code are constraints.

## 2. One learner message, end to end

A learner is in Phase 1 and types *"the auth controller and probably the user
model"*. Here is every place it goes.

### 2.1 `POST /api/session/:id/message` — `src/server/index.js`

Finds the session (memory, then `data/sessions/<id>.json`), rejects an empty
body unless the state is `WAIT_FOR_AGENT`, and calls `step()`. The route does
not look at the scenario. It returns whatever `uiFor()` decides the browser may
see.

### 2.2 `step(session, input)` — `src/engine/controller.js`

Records the learner turn, then **classifies before doing anything else**:

```js
const turn = classifyLearnerTurn(input);
```

### 2.3 `classifyLearnerTurn()` — `src/engine/guardrails.js`

Returns `{ exit, answerDemand, promptExtraction, attemptLevel, wordCount }`.

- `exit` — `"skip"` or `"stop"` only when the whole message is that word. "I
  would skip the rate limiter" is not an exit.
- `promptExtraction` — seven patterns, including role-play framings.
- `answerDemand` — eight patterns.
- `attemptLevel` — 0, 1 or 2, computed **after stripping the demand**, so "just
  tell me, but I think it's the controller" still counts as a try. "I don't
  know" is capped at 1: engagement, never an attempt.

Our message: no exit, no probe, no demand, `attemptLevel` 2.

### 2.4 Interrupt branches — `controller.js`

Four early returns, in order: stop, skip, prompt extraction, answer demand
without an attempt. The last of those calls `hintLadder()` and **does not
advance the state**. Ours falls through all four.

### 2.5 `HANDLERS[S.PREDICT_FILES]()` — `controller.js`

First, resolve the phrases against the repo:

```js
const resolved = resolveAgainstRepo(input, scenario.public.repoMap);
```

### 2.6 `resolveAgainstRepo()` — `src/engine/matcher.js`

Sees `scenario.public.repoMap` and nothing else. For each path it builds alias
phrases with `deriveAliases()` — `server/controllers/authController.js` yields
`authcontroller.js`, `auth controller`, `controllers/authcontroller` and more —
then tests each against the normalised input.

`normalise()` splits camelCase **before** lowercasing, so a typed
`authController` and a dictated "auth controller" become the same string.

Two outputs. `resolved` is the paths clearly named. `ambiguous` is a phrase that
fits more than one existing file: "the auth file on the server" matches both
`server/routes/auth.js` and `server/controllers/authController.js`.

If there is an ambiguity, the handler returns an options question immediately
and the state does not advance. That is deterministic on purpose: offering the
candidates is the repair learners prefer (Ashktorab et al., CHI 2019) and it
should not be left to a model's mood.

Our message resolves `server/controllers/authController.js` and
`server/models/User.js`, with no ambiguity.

### 2.7 Store, record, build the next turn

```js
session.prediction.files = { text: input, resolved, ambiguous: [] };
recordProgress(session, 'files', effort === 2 ? 'unaided' : 'hinted');
```

`recordProgress()` (`session.js`) is first-write-wins: being told after two
hints is `revealed`, not `unaided`.

Then:

```js
const ctx = buildPhase1Context({ session, scenario, turnGoal, priorContext });
```

### 2.8 `buildPhase1Context()` — `src/engine/context.js`

**This is the boundary.** It throws if the state is Phase 2, then calls
`publicView(scenario)` — request, conventions, repo map, plan *count*. It never
touches `scenario.secret`.

It renders `prompts/<version>/phase1_elicit.md`, substituting `{{REQUEST}}`,
`{{CONVENTIONS}}`, `{{REPO_MAP}}`, `{{TURN_GOAL}}`, `{{PRIOR_CONTEXT}}` and
`{{LEARNER_BACKGROUND}}`. `fill()` throws on an unfilled placeholder: a prompt
that still says `{{GAP}}` produces a quietly worse reply, the hardest kind of
fault to spot in a transcript.

Last, `assertNoSecret()` scans the finished prompt for any added path or diff
line and throws if it finds one. Belt and braces: the prompt was built from the
public view, so this should never fire. If it ever does, something upstream is
wrong and the request should stop, not continue.

### 2.9 `say()` — `controller.js`

```js
const raw = await complete({ system: ctx.system, messages: ctx.messages });
const scan = scanReply(raw, { state: session.state, scenario });
```

`complete()` (`src/llm/provider.js`) is the only model call in the system.

`scanReply()` (`guardrails.js`) builds needles from the scenario: added paths,
diff lines of 15 characters or more, the final-check question, concept
explanations. In an `ELICIT_ONLY` state, a reply containing any of them is
**replaced wholesale** with `safeFallback()` and the violation is recorded on
the session. Wholesale, not redacted: a partial redaction still announces that
there was something to redact.

### 2.10 Transition and entry actions

The handler returned `{ reply, next: S.PREDICT_MECHANISM }`. `step()` sets the
state, then runs `runEntryActions()`.

Some states open by asking something — `GROUND` asks the prerequisite,
`FINAL_CHECK` asks the transfer question, `CARD` emits the card and chains to
`END`. Without entry actions those questions would wait for the next learner
message, and the learner would be answering a question they had not been shown.
This was a real bug, fixed in `4852ce3`.

### 2.11 Back out

`addTurn`, `save` to `data/sessions/<id>.json`, and return
`{ reply, ui: uiFor(...), done }`.

`uiFor()` returns **no file list in Phase 1**. The browser cannot render what it
was never sent.

## 3. Where each design goal lives

| Design goal | Enforced by | File |
|---|---|---|
| DG1 elicit before explaining | `ELICIT_ONLY`; Phase 1 context excludes the secret; reply scanner; hint ladder | `states.js`, `context.js`, `guardrails.js` |
| DG2 ground before explaining | `ENTRY[S.GROUND]` asks the prerequisite; the handler picks short vs long explanation from the answer | `controller.js` |
| DG3 use the run time, never interrupt | threshold check in `begin()`; `canPause()`; `applyAgentEvent` | `controller.js`, `states.js` |
| DG4 read-only, declared up front | there is no write path; `secretView()` throws; G2 patterns | `scenarios.js`, `guardrails.js` |

DG4 is worth stating plainly: the system has **no code that writes to a
repository**. It is not prevented from editing, it is incapable of it.

## 4. Changing things

### Add a scenario

Drop a `.json` in `scenarios/`. It is picked up at startup; there is no
registry. Run `npm test` — `test/scenarios.test.js` validates it and checks the
public view leaks nothing. Format: `scenarios/SCHEMA.md`.

### Change a prompt

Copy `prompts/v1` to `prompts/v2` and edit the copy. **Do not edit v1 in
place**: the judge results record which version produced them, and A2 asks for
every version. Point a session at it with `HC_PROMPT_VERSION=v2` or
`createSession({ promptVersion: 'v2' })`.

Then regenerate and re-judge, because a prompt change invalidates the
conversations:

```bash
npm run judge:conversations
npm run judge:run -- --cv=v1
npm run judge:agreement
```

### Change a judge criterion

Add `llm_judge/criteria/c1_no_premature_verdict.v2.md` beside the v1 file.
`run_judge.js` picks the highest version unless you pass `--cv=v1`, so both can
be run over the same conversations and reported before and after.

### Add a guardrail

Patterns go in `guardrails.js`, with a test in `test/guardrails.test.js` that
fails before the change. If it needs the scenario secret it belongs in
`scanReply`, not in a prompt.

## 5. Things that will bite

- **`fill()` throws on unfilled placeholders.** If you add `{{THING}}` to a
  prompt you must pass `THING` from `context.js`.
- **`secretView()` throws outside Phase 2.** If you need scenario data in a new
  Phase 1 code path, you almost certainly should not have it. Check whether the
  learner could legitimately know it; if so, it belongs in `public`.
- **Scenario validation runs at startup**, so a malformed scenario stops the
  server rather than failing halfway through a demo.
- **Alias matching ignores leading determiners.** Authored aliases read as "the
  reset page" but learners write "a reset page". Keep authored aliases natural
  and let the matcher handle the article.
- **Tests run offline** with `HC_PROVIDER=mock`. Model wording is canned;
  transitions, scoring and guardrail decisions are the real code path. Anything
  that depends on the model's actual words belongs in `llm_judge/`, not here.
