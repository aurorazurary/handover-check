# Scenario format

A scenario is one recorded "agent run": what the learner asked for, what the repo
looked like beforehand, what the agent planned, and what it actually changed.

The file is split into **`public`** and **`secret`** for one reason, and it is the
most important design decision in the system:

> **Phase 1 prompts are built from `public` only. The `secret` object is never
> loaded into the model context, and never serialised to the browser, until the
> session reaches Phase 2.**

That makes "do not reveal the answer early" a property of the architecture rather
than an instruction in a prompt. During prediction the CUI cannot name a changed
file or quote a diff line because it has not been given them. See
`src/engine/context.js` (`buildPhase1Context`) and `src/engine/guardrails.js`.

## Why the repo map is public but the plan is not

A learner can always open their own repository, so hiding the file tree would be
artificial and would make prediction a memory test. A learner cannot see the diff
before it exists, and if they can read the agent's plan then "which files will
change?" is a copying task, not a prediction.

So the split follows what the learner could legitimately know at that moment:

| Visible in Phase 1 | Hidden until Phase 2 |
|---|---|
| The request they typed | The agent's plan |
| The repo file tree as it was before the change | The list of changed files |
| Repo conventions (where routes live, etc.) | The diff hunks |
| | The data path, concepts and final check |

## Fields

```jsonc
{
  "id": "password-reset",              // stable id, used in URLs and logs
  "title": "Add forgot / reset password",
  "stack": "React + Express",
  "learnerProfile": "...",             // who this scenario is pitched at
  "planFileCount": 6,                  // size of the agent's plan; compared to
                                       // the learner's threshold to decide whether
                                       // Handover Check activates at all (DG3)
  "estimatedAgentRunSeconds": 240,     // how long the simulated run takes

  "public": {
    "request": "...",                  // the learner's own words to the agent
    "conventions": "...",              // one paragraph: how this repo is laid out
    "repoMap": ["server/routes/auth.js", "..."]   // tree BEFORE the change
  },

  "secret": {
    "plan": { "files": ["..."] },      // what the agent said it would touch

    "changes": [                       // what it actually touched
      {
        "path": "server/controllers/authController.js",
        "inPlan": true,                // false => unrequested, surfaced in Phase 2
        "role": "generates the token, stores its hash and expiry, sends the email",
        "aliases": ["the auth controller", "the controller"],  // extra phrasings
                                       // the matcher should accept, on top of the
                                       // ones derived automatically from the path
        "hunk": [                      // the lines shown when this gap is revealed
          { "type": "ctx", "text": "const token = randomToken();" },
          { "type": "add", "text": "const tokenHash = sha256(token);" }
        ]
      }
    ],

    "dataPath": [                      // the mechanism, as an ordered chain
      { "from": "...", "to": "...", "via": "..." }
    ],

    "mechanismKeyPoints": [            // what a complete explanation must contain;
      {                                // the grading rubric is built from these
        "id": "token-on-server",
        "statement": "The token is generated on the server, not in the browser.",
        "why": "A client-generated token could be forged by anyone."
      }
    ],

    "concepts": [                      // checked before being explained (DG2)
      {
        "id": "express-middleware",
        "name": "Express middleware",
        "prereqQuestion": "Before I explain it - do you know what Express middleware is?",
        "shortExplanation": "...",     // used when the learner already knows it
        "longExplanation": "...",      // used when they are vague
        "analogies": {                 // picked from the learner's stated background
          "java": "Like a servlet filter...",
          "python": "Like a Flask before_request hook...",
          "default": "Like a checkpoint the request passes through..."
        }
      }
    ],

    "finalCheck": {
      "question": "To change the expiry from 1 hour to 6 hours, which file do you edit?",
      "answerPath": "server/controllers/authController.js",
      "answerDetail": "in forgot(), the line that sets user.resetTokenExpiry",
      "distractors": [
        { "path": "server/models/User.js",
          "note": "stores the expiry, but does not set it" }
      ]
    }
  }
}
```

## Adding a scenario

1. Drop a `.json` file in this folder. It is picked up automatically by
   `src/engine/scenarios.js` at startup; there is no registry to update.
2. Run `npm test` — `test/scenarios.test.js` validates every scenario against
   this schema and fails if `secret.plan.files` contains a path that is not in
   `secret.changes`, or if a changed file is missing a `role`.
3. Check the numbers you quote in the UI: `planFileCount` must equal
   `secret.plan.files.length`.
