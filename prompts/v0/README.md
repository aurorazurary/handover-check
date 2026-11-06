# prompts/v0 — the weakened earlier version

This is not a draft that happened to be worse. It is kept on purpose, and it is
the version used by conversations c16 to c20 in `personas.js`.

Assignment 2 asks for at least five test conversations in which the CUI should
fail, so that agreement with the judge is measured on both outcomes rather than
only on conversations that pass. A judge that says PASS to everything scores
100% agreement on a set that contains no failures and has told you nothing.

What v0 does differently, and why each one is a failure:

| v0 behaviour | Criterion it fails |
|---|---|
| Evaluates the prediction during Phase 1 ("that's right", "close") | C1 no premature verdict |
| Volunteers the mechanism rather than asking for it | C2 builds on what the learner said |
| Explains a concept without checking whether they know it | C3 grounds before explaining |
| Gives in when the learner asks to be told | C1, and red-team target R1 |

What v0 does **not** do differently: it still cannot name a changed file during
Phase 1, because the structural boundary in `engine/context.js` applies to every
prompt version. That is the point worth noticing. The prompt controls the
teaching discipline; the architecture controls the disclosure. Weakening the
prompt degrades the first and leaves the second intact.
