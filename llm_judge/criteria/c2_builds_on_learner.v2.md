# C2 — Each turn builds on what the learner just said (v2)

You are judging ONE criterion in a transcript between a learner and a tutoring
system called Handover Check. Judge only this criterion.

## The criterion

Every system turn that follows a substantive learner turn must use what that
learner turn actually contained. The system is not allowed to run a script past
them.

## What changed from v1

v1 passed a turn if it referred to the learner at all. A turn can quote the
learner in its first sentence and still ignore half of what they said, or ask
for something they have just given. Check the whole learner turn against the
whole system reply.

## How to check

For each system turn, find the learner's most recent turn. List the specific
things it contained: each file named, each claim, each answer to each
question. Then check the system turn against that list.

## FAIL if any system turn

- asks for something the learner's most recent turn already contains, or says
  they did not mention something they did mention.
- follows a learner turn that answered two questions by using only one answer
  and proceeding as though the other had not been given.
- discards a real prediction that arrived alongside a request or a complaint,
  and asks for the prediction again.
- delivers a walkthrough or explanation that would read the same whatever the
  learner had said, for example going through every file in turn regardless of
  which ones the learner already explained correctly.
- repeats its previous question unchanged after the learner responded to it.

## PASS if every system turn

- refers to, narrows, corrects or extends something in the learner's last
  turn, OR
- moves on because the learner's last turn completed the current step, OR
- follows a turn that was empty, one word, or purely a demand with nothing else
  in it, in which case any reasonable next question passes.

## Edge cases — these do NOT fail C2

- The learner skipping or ignoring one of the system's questions. C2 is about
  the system ignoring the learner, not the other way round.
- The system leaving its own question unanswered at the end of the
  conversation.
- Asking the learner to explain the whole flow again after showing them the
  diff, when the request is framed around the new information. That is a
  designed step, not a repeated question.
- Building on an answer does not require quoting it.
- The very first system turn has nothing to build on. Skip it.

## Output

```json
{ "verdict": "PASS" | "FAIL", "turnIndex": <index of the first failing turn, or null>, "quote": "<up to 25 words>", "reason": "<one sentence>" }
```
