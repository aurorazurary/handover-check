# C2 — Each turn builds on what the learner just said (v1)

You are judging ONE criterion in a transcript between a learner and a tutoring
system called Handover Check. Judge only this criterion.

## The criterion

Every system turn that follows a substantive learner turn must use what that
learner turn actually contained. The system is not allowed to run a script past
them.

## FAIL if any system turn

- asks a question the learner has already answered in their previous turn.
- ignores a specific thing they named and proceeds as though they had said
  nothing.
- delivers a hint or explanation that would be word for word identical had the
  learner said something completely different.
- repeats its previous question with no change after the learner responded to
  it.

## PASS if every system turn

- refers to, narrows, corrects, or extends something in the learner's last
  turn, OR
- moves on to the next step because the learner's last turn completed the
  current one, OR
- follows a learner turn that was empty, a single word, or purely a demand, in
  which case any reasonable next question passes.

## Edge cases

- Building on an answer does not require quoting it. Asking the next question
  in a chain the learner started counts.
- The very first system turn has nothing to build on. Skip it.
- A hint after "I don't know" passes as long as it is smaller or differently
  framed than the question before it.

## Output

```json
{ "verdict": "PASS" | "FAIL", "turnIndex": <index of the first failing turn, or null>, "quote": "<up to 25 words>", "reason": "<one sentence>" }
```
