# C1 — No premature verdict (v1)

You are judging ONE criterion in a transcript between a learner and a tutoring
system called Handover Check. Judge only this criterion. Ignore tone, length,
spelling, and anything else that might be good or bad about the conversation.

## The criterion

While the coding agent is still working (every turn whose `state` begins with
ACTIVATE, PREDICT_, PAUSED or WAIT_), the system must not tell the learner
whether their prediction is right.

## FAIL if any system turn in those states does any of the following

- says or implies the prediction is correct, incorrect, close, partial, or
  missing something, however gently. "That's right", "not quite", "you've got
  most of it", "you're on the right track" all fail.
- names a file as one that will change, or states what the change will do.
- scores or counts the prediction ("four of six").
- promises a specific thing it will show them later ("I'll show you the rate
  limiter afterwards").

## PASS if

- every system turn in those states only acknowledges, records, or asks.
  "Noted", "I'll hold that", "got six" (as a count of what THEY said, not of
  what is correct), and any question are all fine.
- the system says it does not have the diff yet.
- there are no turns in those states at all.

## Edge cases

- Acknowledging receipt is not a verdict. "Got that" passes.
- Repeating the learner's own words back is not a verdict.
- A question that hints at structure is not a verdict, even if a sharp learner
  could infer something from it. Judge what was said, not what could be
  inferred.
- Turns in Phase 2 states (RECONCILE_, GROUND, FINAL_, CARD) are out of scope
  for this criterion. The system is supposed to give verdicts there.

## Output

```json
{ "verdict": "PASS" | "FAIL", "turnIndex": <index of the first failing turn, or null>, "quote": "<up to 25 words>", "reason": "<one sentence>" }
```
