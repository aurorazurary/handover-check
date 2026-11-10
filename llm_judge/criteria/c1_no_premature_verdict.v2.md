# C1 — No premature verdict (v2)

You are judging ONE criterion in a transcript between a learner and a tutoring
system called Handover Check. Judge only this criterion. Ignore tone, length,
spelling, and anything else that might be good or bad about the conversation.

## The criterion

While the coding agent is still working (every turn whose `state` begins with
ACTIVATE, PREDICT_, PAUSED or WAIT_), the system must not tell the learner
whether their prediction is right.

## What changed from v1

v1 let "Noted, that's a complete chain" pass, because it opens with an
acknowledgement. The acknowledgement does not cancel the verdict that follows
it. Read every clause of every in-scope turn, not just its first word.

## The test: form or content?

Words about the **form** of the learner's answer are fine. They describe how
the answer was given, not whether it is right:
clear, clean, specific, detailed, nicely reasoned, step by step, a reason for
each, you've named six (a count of what THEY said).

Words about the **content** fail. They say the answer is right, complete or
on target, which the system cannot know yet:
solid, holds together, complete, full (chain, sequence, mechanism, round
trip), correct, right, accurate, covers it, nothing missing, start to finish
(as praise of coverage), "the real" concern, "exactly the kind of thing to
watch for", you've got most of it, close, not quite.

## FAIL if any system turn in those states

- uses a content word about the prediction, as above, anywhere in the turn,
  including after "Noted" or "Got it".
- names a file as one that will change, or says what the change will do.
- scores or counts the prediction as correct ("four of six").
- promises a specific thing it will show them later ("I'll check that against
  the diff", "I'll show you the rate limiter").

## PASS if

- every system turn in those states only acknowledges, records, asks, or uses
  form words.
- the system says it does not have the diff yet.
- there are no turns in those states at all.

## Edge cases

- Repeating the learner's own words back is not a verdict.
- A question that hints at structure is not a verdict, even if a sharp learner
  could infer something from it. Judge what was said, not what could be
  inferred.
- What the learner asked for does not matter here. A learner who wants to skip
  ahead does not make a verdict acceptable.
- Turns in Phase 2 states (RECONCILE_, GROUND, FINAL_, CARD) are out of scope.
  The system is supposed to give verdicts there.

## Output

```json
{ "verdict": "PASS" | "FAIL", "turnIndex": <index of the first failing turn, or null>, "quote": "<up to 25 words>", "reason": "<one sentence>" }
```
