# Handover Check

A conversational interface that sits beside a coding agent. While the agent
works, it asks the learner what they expect it to change. When the agent
finishes, it compares that prediction with the real diff and explains **only
what the learner missed**. It never edits code.

Built for CS3249 Assignment 2, from the design prototyped in Assignment 1.

---

## Install and run

Requires Node 20 or newer (developed on 22).

```bash
npm install
cp .env.example .env     # then paste your Anthropic key into ANTHROPIC_API_KEY
npm start                # http://localhost:3000
```

Without a key it still runs, with canned replies:

```bash
HC_PROVIDER=mock npm start
```

Other entry points:

```bash
npm test                 # 52 unit tests, no key needed
npm run chat             # the same engine in the terminal
npm run chat -- --scenario=eval-buckets --threshold=2
```

## What it uses

| | |
|---|---|
| **Model** | Anthropic Claude (`claude-sonnet-5` by default) via `@anthropic-ai/sdk`. Set with `HC_MODEL`. |
| **Judge model** | Separate setting, `HC_JUDGE_MODEL`. A judge that shares the system's blind spots will not find them. |
| **Speech** | Web Speech API, in the browser. Dictation and spoken prompts, both optional, both Chrome and Edge only. No speech data leaves the browser. |
| **Server** | Express. No database: sessions are JSON files in `data/sessions/`. |
| **Everything else** | Plain ESM JavaScript with JSDoc types. No build step, no bundler, no framework. |

Three environment variables matter: `ANTHROPIC_API_KEY`, `HC_PROVIDER`
(`anthropic` or `mock`) and `HC_PROMPT_VERSION` (`v1`, or `v0` for the
deliberately weakened set). See `.env.example`.

## The one idea worth knowing

A scenario is split into `public` (the learner's request, the repo file tree)
and `secret` (the agent's plan, the diff, the concepts, the final check).

**During Phase 1 the secret is never loaded into the model's context.** Not
withheld by instruction: absent. `buildPhase1Context()` in
`src/engine/context.js` reads `publicView()` only, and `secretView()` throws if
it is called before the session reaches Phase 2.

That is what makes the prediction meaningful. The learner can see their own
repository, because in real life they could. They cannot see the plan, because
in real life it does not exist yet, and if they could read it then "which files
will change?" is a copying exercise rather than a prediction.

It is also why the system cannot be talked into revealing the answer early. It
has nothing to reveal.

## Where things are

```
src/engine/          the interaction. No HTTP, no DOM, no model calls except through llm/
  states.js          the state machine as data: phases, transitions, which states must stay silent
  controller.js      one learner message in, one reply out. Decides the kind of turn
  context.js         builds the prompt. The public/secret boundary lives here
  matcher.js         "the auth controller" -> server/controllers/authController.js, deterministically
  guardrails.js      classifies the learner's turn, scans the reply, hint ladder
  scenarios.js       loads scenarios, enforces publicView / secretView
  session.js         session state, progress record, the handover card
src/llm/
  provider.js        the only module that calls a model. Anthropic, or a mock
  prompts.js         loads prompts/<version>/*.md and fills placeholders
src/server/index.js  HTTP routes. Thin: holds sessions, calls the controller
src/cli/chat.js      the same engine in a terminal
public/index.html    the browser front end, single file
prompts/v1/          the prompts in use
prompts/v0/          a deliberately weakened earlier version, used for judge testing
scenarios/*.json     three recorded agent runs. SCHEMA.md explains the format
llm_judge/           personas, criteria, runners, agreement calculation
red_team/            targets, attempts, PASS/FAIL rules, runner
test/                unit tests, all offline
docs/                architecture, developer guide, user guide
```

## Testing

```bash
npm test                          # unit tests, offline

npm run judge:conversations       # 20 conversations: a model plays each persona
npm run judge:run                 # the judge scores them, one criterion at a time
npm run judge:agreement           # your labels vs the judge: percentage and kappa

npm run redteam                   # 6 attempts x 3 runs against both targets
npm run redteam -- --tag=after-fix
```

The judge and red-team runners refuse to start in mock mode. Judging canned
replies would produce a number that means nothing.

`llm_judge/labels.csv` is yours to fill in from `labels.template.csv`, before
looking at the judge's output. Nothing in this repository writes to it.

## Documentation

- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — for a learner using it
- [`docs/DEVELOPER.md`](docs/DEVELOPER.md) — architecture, one message traced
  end to end, how to add a scenario, how to change a prompt safely
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the diagram and the state machine
- [`scenarios/SCHEMA.md`](scenarios/SCHEMA.md) — the scenario format and why it
  is split the way it is
- [`red_team/RULES.md`](red_team/RULES.md) — the two things it must never do

## Limits

- The coding agent is **simulated**. Scenarios are recorded runs, not a live
  hook into Claude Code or Cursor. The engine receives the same events a real
  hook would post, so replacing the simulation is a change to who posts to
  `/api/session/:id/agent`, but that work has not been done.
- Grading a free-text explanation is a model call, so it is probabilistic. The
  file-level half is deterministic; the mechanism half is not. Every reveal
  shows the actual changed lines so a wrong grade can be seen rather than
  trusted.
- Speech recognition on identifiers is unreliable. The system asks rather than
  guesses when a phrase matches two files, and text input is always available.
- The red-team attempts were written by the person who wrote the defences,
  which is the weakest position from which to look for holes.

## Licence

MIT. See `LICENSE`.
