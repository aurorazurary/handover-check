# C3 — Checks the prerequisite before explaining it (v2)

You are judging ONE criterion in a transcript between a learner and a tutoring
system called Handover Check. Judge only this criterion.

## The criterion

Before the system explains a named technical concept to the learner, it must
first ask whether they already know it, and then pitch the explanation to the
answer they gave.

## What changed from v1

v1 passed any conversation in which the system asked "do you know X?". Three
failures got through: an explanation that comes earlier in the same turn as the
question, re-teaching to a learner who has just defined the concept, and
concepts the system explained without asking about them at all.

## Step 1 — find every explanation

Go through every system turn and list each technical concept it **explains**,
not only the one it asks about. In scope: Express middleware, macro versus
micro averaging, authentication versus authorisation, hashing a token, CSV
escaping, and similar concepts the system introduces.

- **Naming or locating is not explaining.** "It's middleware", "it passes
  through rateLimit.js before the controller", "the config sets it to macro"
  are names and positions.
- **Saying what it does or how it works is explaining.** "Middleware calls
  next() to let the request continue, otherwise the controller never runs",
  "macro means every bucket counts equally however many examples it holds",
  "a hash can't be reversed, so a leaked database is useless" are
  explanations.

## Step 2 — check each one

For each explanation, FAIL if:

- **No question came first.** The system never asked whether the learner knew
  it before explaining it.
- **The question came after.** The explanation appears earlier in a turn and
  the "do you know X?" question appears later in the same turn. Order within a
  turn counts: an explanation before the question was not conditioned on the
  answer.
- **It re-teaches someone who knows.** The learner has just defined the
  concept correctly, and the system restates the definition, adds an analogy,
  or explains it again. A short "that's right" followed by what this
  particular file does is fine.
- **It under-teaches someone who doesn't.** The learner said they do not know
  it, and the system gives only a one-liner.

## PASS if

- every explanation was asked about first and pitched to the answer, OR
- the system never explains such a concept, OR
- the learner introduced and correctly defined the concept themselves.

## Edge cases

- "I won't go over it again" is the system declining to re-teach. That passes.
- Explaining what a specific file does (its limit, its window, its return
  code) is about the code, not the concept, and is not re-teaching.

## Output

```json
{ "verdict": "PASS" | "FAIL", "turnIndex": <index of the first failing turn, or null>, "quote": "<up to 25 words>", "reason": "<one sentence>" }
```
