# Step 3: User study design

> Draft. The reasoning must be yours. Target ~950 words.
> Full questionnaire, task and interview items go in an appendix.

---

## 3.1 Research questions

The design goals the built system supports, each turned into something testable
about learners rather than about the software.

| | Design goal | Research question / hypothesis |
|---|---|---|
| **RQ1** | DG1 elicit before explaining | Does predicting a change before seeing it produce a better explanation of that change than reading an explanation of it? **H1:** learners who predict first explain more of the mechanism unaided, a week later, than learners who are given a walkthrough. |
| **RQ2** | DG1 (transfer) | Does it transfer? **H2:** learners who predict first are more often able to locate where to make an unseen modification, without asking an agent. |
| **RQ3** | DG2 ground before explaining | Does checking the prerequisite before explaining change what the learner takes away, compared with explaining regardless? **H3:** learners who are asked first report less of the "it assumes I know something" difficulty and score higher on the concept item. |
| **RQ4** | DG3 use the run time, do not interrupt | Would learners actually use this unprompted, and does the threshold keep it tolerable? **H4:** given free choice over four sessions, learners accept the check on large changes more often than they skip it, and acceptance does not fall over time. |
| **RQ5** | difficulty from A1 | Does it close the gap between felt and demonstrated understanding? **H5:** the difference between self-rated confidence and demonstrated explanation narrows more in the Handover Check condition. RQ5 matters because the Assignment 1 evidence was exactly this gap: P3 rated himself 8/10 and could not define a `Sub`. |

## 3.2 Study design

**Participants.** 36 undergraduates in CS or CEG, years 2 to 4, recruited from
the same population as the Assignment 1 interviews. Inclusion: uses an AI coding
agent at least weekly, and is currently working in a language or framework they
can read but would not write unaided. That second criterion is the learner
definition from Assignment 1 and it has to be screened for, not assumed.

36 gives roughly 18 per arm. With a medium-to-large effect (d ≈ 0.8, which is
what I would need to see to believe this is worth building) that is around 70%
power at α = .05. I would report that as a limitation rather than claim it is
adequately powered.

**Design.** Mixed. Condition is between-subjects, time is within-subjects.

- **Condition A (Handover Check):** predict, then reconcile.
- **Condition B (active control):** the same system with Phase 1 removed. The
  agent finishes, and the CUI walks them through the diff with the same content,
  the same code excerpts, and the same final check. It answers questions.

Condition B matters more than a do-nothing control. A no-tool comparison would
confound the effect of *predicting first* with the effect of *having a tutor at
all*, and the second is not in dispute. B isolates the prediction, which is the
one claim Assignment 1 actually makes. B is already implementable: it is the
existing engine entered at `RECONCILE_FILES`.

**Task.** Participants use a coding agent on a repository they have not seen, in
a stack they can read but not write (assigned by screening). They request two
features. The system runs on both. The repository and features are the same for
everyone, so prior knowledge is a measured covariate rather than noise.

**Procedure.**

1. *Screening* (online, 5 min): languages written vs read, agent usage, consent.
2. *Session 1* (50 min, lab): a 5-minute orientation to the repository; feature
   1 with the agent and their assigned condition; immediately afterwards, the
   explanation task and the modification task; then the questionnaire.
3. *Sessions 2 to 4* (remote, own time, over two weeks): features 2 to 4, with
   the check **optional**. Acceptance and skips are logged. This is the only way
   to get at RQ4: a learner who is told to use it tells you nothing about
   whether they would.
4. *Delayed post-test* (day 8, 25 min, remote): explanation and modification
   tasks on **feature 1**, which they have not seen for a week. This is the
   primary outcome. Immediate recall after a walkthrough is easy; what matters
   is what survives.
5. *Interview* (20 min, 12 participants, stratified by condition and by
   performance): semi-structured, on the experience of being asked to predict.

**Why this shape.** The delayed post-test is primary because the Assignment 1
difficulty is not "cannot understand at the time", it is "cannot account for it
when someone asks later". P2's behaviour was to cram the night before an
interview. A design that measures understanding five minutes after a walkthrough
would miss the entire problem.

## 3.3 Measures

| Design goal | Measure | How |
|---|---|---|
| DG1 explanation | **Mechanism recall score** on the delayed post-test | Participant explains the feature end to end in writing. Scored against the scenario's `mechanismKeyPoints` by two raters blind to condition: stated / implied / missing. Primary outcome. Report Cohen's kappa between raters. |
| DG1 transfer | **Modification locate** | "To change X, which file would you edit?" Four items, two seen in session, two unseen. Binary correct per item. No agent access; screen recorded. |
| DG2 grounding | **Concept item** plus one questionnaire item | Short-answer on the concept the system grounded ("what does Express middleware do, and what would happen without it here?"), plus the A1-derived item *"The explanations assumed I already knew things I did not"* (7-point). |
| DG3 acceptance | **Accept / skip log**, sessions 2 to 4 | Already recorded by the system (`progress.files === 'skipped'`). Reported as acceptance rate by plan size, and as a trend over the three sessions. |
| DG3 cost | **Time on the check** and a single item: *"This was worth the time it took"* | Timestamps already in the transcript. |
| RQ5 calibration | **Confidence minus performance** | Self-rated confidence (1–7) collected *before* the explanation task, then standardised and subtracted from the standardised mechanism recall score. A positive gap is overconfidence. |
| All | **Conversation logs** | `data/sessions/*.json` already records unaided / hinted / revealed per item, which is a process measure rather than a self-report. |

Full instruments in Appendix [X].

## 3.4 Analysis and limitations

**Analysis.** Mechanism recall by a linear model with condition as the factor
and prior familiarity with the stack as a covariate; report effect size with a
confidence interval, not just a *p*. Modification locate by logistic mixed model
with a random intercept per participant, since items are nested. Acceptance by a
binomial model with plan size as a predictor. Calibration gap by the same linear
model as recall. Interviews by reflexive thematic analysis, coded by me, with a
second coder on a 25% subset.

**Risks and what the design does about them.**

| Risk | Why it is real here | Mitigation |
|---|---|---|
| **Novelty** | Being asked to predict is unusual, and unusual is engaging regardless of whether it works. | Four sessions over two weeks, with acceptance tracked over time. A novelty effect should decay; a real one should not. |
| **Demand characteristics** | Participants can see which condition is "the clever one". | Both conditions are presented as versions of the same tool, with the same branding. The delayed post-test is framed as being about the repository. |
| **Time on task confound** | Condition A spends longer in the interaction. | Log time, report it, and include it as a covariate. If the effect disappears once time is controlled, the honest conclusion is that attention explains it, not prediction. |
| **Small sample** | 18 per arm detects only a large effect. | Pre-register the primary outcome, report CIs, and treat RQ3 and RQ5 as exploratory. |
| **Self-selection** | Volunteers who use agents weekly may be the conscientious ones, i.e. P1 types rather than P2 types. | Screen for and stratify on the A1 attitude item ("once it works, I do not go back and read it"). |
| **Rater bias on the primary outcome** | I designed the system and know the hypothesis. | Two raters, blind to condition, scoring against a fixed key, with agreement reported. |
| **Attrition across two weeks** | Remote sessions, student participants, exam period. | Over-recruit to 44; analyse completers and report dropout by condition. |

## 3.5 Why this study can check the design goals

| Design goal | Supports it | Fails to support it | Why the study distinguishes them |
|---|---|---|---|
| DG1 elicit before explaining | Condition A scores higher on delayed mechanism recall than B, with the interval excluding zero. | No difference, or B higher. | Both conditions receive identical content, identical code excerpts and identical total information. The only difference is the order: predict first, or be told first. An effect can therefore be attributed to the prediction and not to the explanation. |
| DG1 transfer | A locates more unseen modifications than B. | No difference, or A is better only on seen items. | Seen and unseen items are scored separately. Better performance on seen items only would mean recall, not transfer, which would falsify the stronger claim while supporting the weaker one. |
| DG2 ground before explaining | A scores higher on the concept item and lower on "assumed I knew things I did not". | No difference on either, or higher recall with no change in the concept measure. | B explains the same concept with the same words but without asking first. Any difference is attributable to the check rather than to the explanation. |
| DG3 do not interrupt | Acceptance on optional sessions stays above 50% on large changes and does not decline from session 2 to 4. | Acceptance falls over sessions, or clusters at the smallest plans. | Acceptance is free choice over time rather than a satisfaction rating. P2 said "I always skip"; this measures whether that happens, rather than asking whether it would. |
| RQ5 calibration | The confidence-minus-performance gap is smaller in A. | The gap is unchanged, or A is merely more confident. | Confidence is collected before performance is measured, so it cannot be contaminated by how the task felt. Overconfidence and competence are separable. |

**What this study cannot show.** It cannot show that the effect survives outside
a study, on the learner's own repository, under deadline. It cannot distinguish
prediction from the generic benefit of being made to retrieve anything at all;
that would need a third arm that asks an unrelated retrieval question, which
36 participants will not support. And it measures explanation and location, not
whether anyone's handover actually went better, which is the outcome the design
is really aimed at.
