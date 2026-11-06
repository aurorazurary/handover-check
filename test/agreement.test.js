import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cohensKappa } from '../llm_judge/agreement.js';

test('perfect agreement gives kappa 1', () => {
  const k = cohensKappa([
    { mine: 'PASS', theirs: 'PASS' },
    { mine: 'FAIL', theirs: 'FAIL' },
    { mine: 'PASS', theirs: 'PASS' },
    { mine: 'FAIL', theirs: 'FAIL' },
  ]);
  assert.equal(k.po, 1);
  assert.equal(k.kappa, 1);
});

test('a judge that always says PASS scores 90% agreement and kappa of zero', () => {
  // Eighteen of twenty conversations pass. The judge says PASS to all twenty,
  // so it is right 90% of the time while knowing nothing. This is the reason
  // A2 asks for kappa as well as percentage, and the reason the test set
  // contains five conversations that should fail.
  const pairs = [];
  for (let i = 0; i < 18; i += 1) pairs.push({ mine: 'PASS', theirs: 'PASS' });
  for (let i = 0; i < 2; i += 1) pairs.push({ mine: 'FAIL', theirs: 'PASS' });
  const k = cohensKappa(pairs);
  assert.equal(k.po, 0.9, '90% agreement looks fine');
  assert.equal(k.kappa, 0, 'kappa says it is no better than chance');
});

test('kappa is undefined only when both raters used a single label', () => {
  const k = cohensKappa(Array(10).fill({ mine: 'PASS', theirs: 'PASS' }));
  assert.equal(k.po, 1);
  assert.equal(k.kappa, null, 'no variation on either side, so kappa says nothing');
});

test('kappa is lower than raw agreement when the set is unbalanced', () => {
  const pairs = [
    ...Array(15).fill({ mine: 'PASS', theirs: 'PASS' }),
    ...Array(2).fill({ mine: 'FAIL', theirs: 'FAIL' }),
    { mine: 'PASS', theirs: 'FAIL' },
    { mine: 'FAIL', theirs: 'PASS' },
    { mine: 'FAIL', theirs: 'PASS' },
  ];
  const k = cohensKappa(pairs);
  assert.ok(k.po > 0.8);
  assert.ok(k.kappa < k.po, 'kappa discounts the agreement expected by chance');
  assert.ok(k.kappa > 0);
});

test('chance-level agreement gives kappa near zero', () => {
  const pairs = [
    { mine: 'PASS', theirs: 'PASS' },
    { mine: 'PASS', theirs: 'FAIL' },
    { mine: 'FAIL', theirs: 'PASS' },
    { mine: 'FAIL', theirs: 'FAIL' },
  ];
  const k = cohensKappa(pairs);
  assert.equal(k.kappa, 0);
});

test('an empty set reports nothing rather than crashing', () => {
  const k = cohensKappa([]);
  assert.equal(k.n, 0);
  assert.equal(k.kappa, null);
});
