# Using Handover Check

For the learner. Five minutes, four of them while the agent is working anyway.

---

## What it is for

You asked a coding agent to build something. It will finish, it will probably
work, and you will not be able to explain it. That is fine until someone asks:
a supervisor, an interviewer, the person who takes over your project.

Handover Check asks you first. While the agent works, it asks what you think
will change and how you think the feature should work. When the agent finishes,
it compares your answers with the real diff and tells you **only the parts you
missed**.

It does not touch your code. It has no ability to.

## Starting

```bash
npm start
```

Open http://localhost:3000, pick a run, and set two things:

**Only interrupt me above N files.** The default is 4. If the agent's plan is
smaller than that, Handover Check stays quiet and you will not hear from it.
Set it to 2 if you want it to speak up more often, or 8 if you only want it on
the big ones.

**Languages you write without help.** Used to pick analogies. If you write
Java, middleware gets explained as a servlet filter. It is not a judgement and
it is not stored anywhere beyond the session.

## Phase 1: while the agent works

The left panel is the agent. You will see a count of how many files it has
written, never which ones. That is deliberate.

You get two questions.

**"Which files do you think it will touch?"** Answer in your own words. You do
not need paths. "The auth controller and probably the user model" is a fine
answer, so is "the two new pages and whatever handles the route".

**"What should happen, step by step?"** Forget files. Describe the journey:
what happens when the user clicks the button, and what has to be true for it to
work. You do not need to know the framework to answer this.

Three things to expect:

- **It will not tell you whether you are right.** Not out of strictness: the
  change does not exist yet, and it has not been given the plan. There is
  genuinely nothing to tell you.
- **If a name is ambiguous it will ask.** Say "the auth file" and it will come
  back with the two files that could be, rather than guessing.
- **If you ask it to just tell you, it will ask something smaller instead.** It
  gets smaller each time. It does not lecture you about it.

If the agent needs you (an install to approve, say), Handover Check goes quiet
and waits. Deal with the agent; it picks up where it left off.

Say **skip** at any point to decline this run. Say **stop** to end it.

## Phase 2: when the agent finishes

Now it has the diff, and it starts with yours.

**Files.** You get a count: you named six of the seven, say. Files you named
are marked, files you missed are marked differently, and anything the agent
added **that was never in the plan** is highlighted separately. You could not
have predicted those, so they are not counted against you. They are usually the
most interesting thing on the screen.

**Mechanism.** You explain how it works. It tells you only what you left out,
and shows the actual changed lines when it does. If it claims you missed
something, you can see the evidence.

**A concept check.** Before it explains something like Express middleware, it
asks whether you already know it. Say yes and you get one sentence. Say no and
you get the longer version with an analogy in a language you do write. Either
way the question is real, not rhetorical.

**One decision is yours.** If the agent added something you did not ask for,
you are asked whether to keep it. Handover Check does not have an opinion and
does not act on your answer. It records it on the card.

**One last question.** Something you have not been shown: "to change the expiry
from one hour to six, which file?" If you can name the file, you can change the
feature without the agent. That is the whole point.

## The card

At the end you get a handover card:

```
Password reset
Files        7 changed, you predicted 6 of the 6 that were planned
Mechanism    unaided
Concept      hinted
Can modify   unaided
Unrequested  server/middleware/rateLimit.js, kept for you to decide
Say tomorrow the token is stored as a hash, not the token itself
             the token expires after an hour
```

Each line records **how you got there**, not a score: `unaided`, `hinted`, or
`revealed`. Nothing in it is an opinion about you.

The card is the thing you take to the handover. Handover Check does not need to
be in the room.

## Voice

Two buttons, both off by default, both Chrome and Edge only.

**Voice** dictates your answer into the box so you can keep watching the agent.
Speech stays in your browser.

**Speak** reads the question aloud. Only the question, never a diff: a file
path read aloud is useless.

Everything works identically by typing. Nothing is lost.

## If something goes wrong

**"Could not reach the server"** — it is not running. `npm start`.

**"canned replies (HC_PROVIDER=mock)"** at the bottom of the setup screen —
there is no API key. Copy `.env.example` to `.env` and add one. It still runs,
but the replies are fixed text rather than responses to what you said.

**It misheard a file name** — it should have offered you options. If it picked
wrong, say the right one; the correction folds into your prediction.

**It asked something you already answered** — that is a bug, and worth
reporting. Every turn is supposed to build on your last one.

## What it will not do

- Edit your code. There is no code path that writes to a repository.
- Tell you what changed before the agent has finished. It has not been given it.
- Print its own instructions.
- Keep an opinion about you. The session records what you did, not what it
  concluded about you.
