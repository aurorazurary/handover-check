import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wordsOf, deriveAliases, normalise, resolveAgainstRepo, scorePrediction,
} from '../src/engine/matcher.js';

const REPO = [
  'client/src/api/auth.js',
  'client/src/pages/Login.jsx',
  'server/routes/auth.js',
  'server/routes/notes.js',
  'server/controllers/authController.js',
  'server/models/User.js',
  'server/lib/mailer.js',
];

const CHANGES = [
  { path: 'client/src/pages/ForgotPassword.jsx', inPlan: true, aliases: ['forgot password page'] },
  { path: 'client/src/api/auth.js', inPlan: true, aliases: ['the api helper'] },
  { path: 'server/routes/auth.js', inPlan: true, aliases: ['the auth routes'] },
  { path: 'server/controllers/authController.js', inPlan: true, aliases: ['the auth controller'] },
  { path: 'server/models/User.js', inPlan: true, aliases: ['the user model'] },
  { path: 'server/middleware/rateLimit.js', inPlan: false, aliases: ['the rate limiter'] },
];

test('wordsOf splits camelCase and drops the extension', () => {
  assert.deepEqual(wordsOf('authController.js'), ['auth', 'controller']);
  assert.deepEqual(wordsOf('ForgotPassword.jsx'), ['forgot', 'password']);
  assert.deepEqual(wordsOf('default.yaml'), ['default']);
});

test('deriveAliases covers the phrasings learners actually use', () => {
  const a = deriveAliases('server/controllers/authController.js');
  assert.ok(a.includes('authcontroller.js'));
  assert.ok(a.includes('auth controller'));
  assert.ok(a.includes('server/controllers/authcontroller.js'));
});

test('normalise splits camelCase so spoken and typed forms agree', () => {
  assert.equal(normalise('The authController, obviously!'), 'the auth controller obviously');
});

test('resolveAgainstRepo finds a file named by its words', () => {
  const r = resolveAgainstRepo('I think it changed the user model', REPO);
  assert.deepEqual(r.resolved, ['server/models/User.js']);
  assert.equal(r.ambiguous.length, 0);
});

test('resolveAgainstRepo asks rather than guesses when a phrase fits two files', () => {
  const r = resolveAgainstRepo('and the auth file on the server', REPO);
  const amb = r.ambiguous.find((a) => a.candidates.length > 1);
  assert.ok(amb, 'expected an ambiguity');
  assert.ok(amb.candidates.includes('client/src/api/auth.js'));
  assert.ok(amb.candidates.includes('server/routes/auth.js'));
});

test('a full path is not reported as ambiguous', () => {
  const r = resolveAgainstRepo('server/routes/auth.js changed', REPO);
  assert.deepEqual(r.resolved, ['server/routes/auth.js']);
  assert.equal(r.ambiguous.length, 0);
});

test('resolveAgainstRepo never sees the changed files', () => {
  // The repo map has no ForgotPassword.jsx, so a predicted new file simply does
  // not resolve. It is matched later, in Phase 2, from the raw text.
  const r = resolveAgainstRepo('a forgot password page', REPO);
  assert.deepEqual(r.resolved, []);
});

test('scorePrediction counts planned files and separates the unplanned one', () => {
  const text = 'a forgot password page, the api helper, the auth routes, '
    + 'the auth controller and probably the user model';
  const s = scorePrediction({ text }, CHANGES, REPO);

  assert.equal(s.score.total, 5, 'five files were in the plan');
  assert.equal(s.score.predicted, 5, 'learner named all five');
  assert.deepEqual(s.missed, [], 'nothing planned was missed');
  assert.deepEqual(s.unplannedMissed, ['server/middleware/rateLimit.js'],
    'the unrequested file is a disclosure, not a miss');
});

test('scorePrediction reports a named file that did not change', () => {
  const s = scorePrediction({ text: 'the auth routes and the mailer' }, CHANGES, REPO);
  assert.ok(s.spurious.includes('server/lib/mailer.js'));
  assert.ok(s.hit.includes('server/routes/auth.js'));
});

test('a partial prediction scores partially', () => {
  const s = scorePrediction({ text: 'the two pages on the frontend' }, CHANGES, REPO);
  assert.ok(s.score.predicted < s.score.total);
  assert.ok(s.missed.includes('server/controllers/authController.js'));
});

test('scoring is deterministic', () => {
  const p = { text: 'the auth controller and the user model' };
  const a = JSON.stringify(scorePrediction(p, CHANGES, REPO));
  const b = JSON.stringify(scorePrediction(p, CHANGES, REPO));
  assert.equal(a, b);
});
