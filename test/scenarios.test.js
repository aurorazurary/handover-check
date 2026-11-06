import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios, getScenario, publicView, secretView } from '../src/engine/scenarios.js';

test('every scenario on disk validates', () => {
  const all = loadScenarios();
  assert.ok(all.length >= 3, `expected at least 3 scenarios, found ${all.length}`);
});

test('the public view carries no part of the plan or the diff', () => {
  for (const s of loadScenarios()) {
    const serialised = JSON.stringify(publicView(s));

    for (const change of s.secret.changes) {
      // A planned path must not appear anywhere in what the learner can see.
      // Files that already existed are in the repo map legitimately, so only
      // added files are checked by path.
      if (change.status === 'added') {
        assert.ok(
          !serialised.includes(change.path),
          `${s.id}: public view leaks the added file ${change.path}`,
        );
      }
      for (const line of change.hunk || []) {
        if (line.text.trim().length < 12) continue;
        assert.ok(
          !serialised.includes(line.text),
          `${s.id}: public view leaks a diff line from ${change.path}`,
        );
      }
    }

    assert.ok(!serialised.includes(s.secret.finalCheck.question));
    for (const c of s.secret.concepts) {
      assert.ok(!serialised.includes(c.shortExplanation));
    }
  }
});

test('the public view does say how big the plan is, without saying what is in it', () => {
  const s = getScenario('password-reset');
  const view = publicView(s);
  assert.equal(view.planFileCount, 6);
  assert.equal(view.repoMap.includes('client/src/pages/ForgotPassword.jsx'), false);
});

test('secretView refuses to open in Phase 1', () => {
  const s = getScenario('password-reset');
  assert.throws(
    () => secretView(s, { phase: 1 }),
    /Refusing to read scenario secret in phase 1/,
  );
});

test('secretView opens in Phase 2', () => {
  const s = getScenario('password-reset');
  const secret = secretView(s, { phase: 2 });
  assert.equal(secret.changes.length, 7);
  assert.equal(secret.changes.filter((c) => !c.inPlan).length, 1);
});

test('every scenario has exactly one unrequested change', () => {
  for (const s of loadScenarios()) {
    const unplanned = s.secret.changes.filter((c) => !c.inPlan);
    assert.equal(unplanned.length, 1, `${s.id}: expected one unplanned change`);
  }
});

test('the final check answer is a file that actually changed', () => {
  for (const s of loadScenarios()) {
    const paths = s.secret.changes.map((c) => c.path);
    assert.ok(paths.includes(s.secret.finalCheck.answerPath), s.id);
    for (const d of s.secret.finalCheck.distractors || []) {
      assert.ok(d.note, `${s.id}: distractor ${d.path} has no note explaining why it is wrong`);
    }
  }
});

test('the data path only mentions files that changed, the repo map, or a named artefact', () => {
  for (const s of loadScenarios()) {
    const known = new Set([...s.public.repoMap, ...s.secret.changes.map((c) => c.path)]);
    for (const hop of s.secret.dataPath) {
      for (const end of [hop.from, hop.to]) {
        const looksLikePath = end.includes('/');
        if (looksLikePath) {
          assert.ok(known.has(end), `${s.id}: data path mentions unknown file ${end}`);
        }
      }
    }
  }
});
