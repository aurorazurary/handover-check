/**
 * Deterministic matching between what a learner says and files in a repo.
 *
 * Learners do not type paths. They say "the auth route file", "the controller",
 * "a forgot password page". This module turns that into concrete paths without
 * involving a model, which is what makes the file half of the scoring
 * reproducible: the same sentence always produces the same score.
 *
 * It is deliberately split into two functions that see different data, because
 * the split is what keeps the hidden plan hidden:
 *
 *   resolveAgainstRepo()  Phase 1. Sees the PUBLIC repo map only. Used to
 *                         recognise and disambiguate the files a learner names
 *                         while predicting. It cannot leak the answer because
 *                         it is never given the list of changed files.
 *
 *   scorePrediction()     Phase 2. Sees the changed files. Only ever called
 *                         after the agent has "finished" and the session has
 *                         moved into reconciliation.
 *
 * @module engine/matcher
 */

/** Words that carry no signal when matching a path phrase. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'to', 'for', 'file', 'files',
  'js', 'jsx', 'ts', 'tsx', 'py', 'yaml', 'yml', 'json', 'probably', 'maybe',
  'think', 'guess', 'some', 'something', 'that', 'this', 'it', 'is', 'are',
  'where', 'which', 'what', 'new', 'change', 'changes', 'changed', 'touch',
  'touched', 'add', 'added', 'modify', 'modified', 'server', 'client',
]);

/**
 * Split an identifier or path segment into lowercase words.
 * "authController.js" -> ["auth", "controller"]
 * "ForgotPassword.jsx" -> ["forgot", "password"]
 *
 * @param {string} segment
 * @returns {string[]}
 */
export function wordsOf(segment) {
  return segment
    .replace(/\.[a-z0-9]+$/i, '')          // drop the extension
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Phrases that should be accepted as referring to this path, derived from the
 * path itself. Scenario authors can add more in the `aliases` field; these are
 * the ones nobody should have to write out.
 *
 * For "server/controllers/authController.js" this yields, among others:
 *   "server/controllers/authcontroller.js", "authcontroller.js",
 *   "authcontroller", "controllers/authcontroller", "auth controller"
 *
 * @param {string} path
 * @returns {string[]} lowercase phrases
 */
export function deriveAliases(path) {
  const segments = path.split('/');
  const file = segments[segments.length - 1];
  const dir = segments[segments.length - 2];
  const stem = file.replace(/\.[a-z0-9]+$/i, '');
  const fileWords = wordsOf(file);

  const out = new Set([
    path.toLowerCase(),
    file.toLowerCase(),
    stem.toLowerCase(),
    fileWords.join(' '),
  ]);

  if (dir) {
    out.add(`${dir}/${file}`.toLowerCase());
    out.add(`${dir}/${stem}`.toLowerCase());
    // "controllers authController" said aloud becomes "controller auth controller";
    // the singular directory word plus the file words covers the common phrasings.
    out.add([...wordsOf(dir), ...fileWords].join(' '));
  }
  return [...out].filter((s) => s.length > 2);
}

/**
 * Normalise a learner utterance for matching: lowercase, collapse whitespace,
 * and keep only characters that can appear in a path or a word.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalise(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase BEFORE lowercasing
    .toLowerCase()
    .replace(/[^a-z0-9/._\- ]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does `haystack` reference `phrase`? Multi-word phrases must appear in order,
 * but may be separated by one or two filler words, so "the auth controller" and
 * "the auth file in controllers" both match "auth controller".
 *
 * @param {string} haystack normalised learner text
 * @param {string} phrase lowercase candidate phrase
 * @returns {boolean}
 */
function references(haystack, phrase) {
  if (phrase.includes('/') || phrase.includes('.')) {
    // Compare with spaces stripped too, so a learner who typed
    // "server/controllers/authController.js" still matches after camelCase
    // splitting turned it into "... auth controller.js".
    const squash = (s) => s.replace(/\s+/g, '');
    return haystack.includes(phrase) || squash(haystack).includes(squash(phrase));
  }
  // Authored aliases read naturally ("the reset page") but learners use a
  // different article ("a reset page") or none at all. Match on the content
  // words, not on the determiner.
  const words = phrase.replace(/^(the|a|an)\s+/, '').split(' ').filter(Boolean);
  if (words.length === 1) {
    return new RegExp(`(^| )${escapeRegExp(words[0])}(s|es)?($| )`).test(haystack);
  }
  const gap = '(?:\\s+\\S+){0,2}\\s+';
  const pattern = words.map(escapeRegExp).join(gap);
  return new RegExp(`(^|\\s)${pattern}`).test(haystack);
}

/** @param {string} s */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * PHASE 1 ONLY. Resolve the file-ish phrases in a learner's prediction against
 * the repository as it exists *before* the change.
 *
 * Two things come out of this:
 *  - `resolved`: paths in the repo map the learner clearly named.
 *  - `ambiguous`: a phrase that fits more than one existing file, e.g. "auth"
 *    when the repo holds client/src/api/auth.js and server/routes/auth.js. The
 *    controller turns these into an options question rather than guessing,
 *    which is the repair strategy learners prefer (Ashktorab et al., CHI 2019).
 *
 * Phrases that match nothing are not an error: the learner may be predicting a
 * file that does not exist yet ("a forgot password page"). Those stay in the
 * raw text and are matched in Phase 2.
 *
 * @param {string} text what the learner said
 * @param {string[]} repoMap paths that existed before the change (PUBLIC)
 * @returns {{resolved: string[], ambiguous: Array<{term: string, candidates: string[]}>}}
 */
export function resolveAgainstRepo(text, repoMap) {
  const hay = normalise(text);
  /** @type {Map<string, string[]>} phrase -> paths it could mean */
  const byPhrase = new Map();

  for (const path of repoMap) {
    for (const alias of deriveAliases(path)) {
      if (!references(hay, alias)) continue;
      if (!byPhrase.has(alias)) byPhrase.set(alias, []);
      byPhrase.get(alias).push(path);
    }
  }

  const resolved = new Set();
  /** @type {Array<{term: string, candidates: string[]}>} */
  const ambiguous = [];

  // Longest phrases first: if the learner said "server/routes/auth.js" we should
  // not also report the bare word "auth" as ambiguous.
  const phrases = [...byPhrase.keys()].sort((a, b) => b.length - a.length);
  const claimed = new Set();

  for (const phrase of phrases) {
    const paths = byPhrase.get(phrase);
    if (paths.every((p) => claimed.has(p))) continue;
    if (paths.length === 1) {
      resolved.add(paths[0]);
      claimed.add(paths[0]);
    } else if (!paths.some((p) => claimed.has(p))) {
      ambiguous.push({ term: phrase, candidates: paths });
      paths.forEach((p) => claimed.add(p));
    }
  }

  return { resolved: [...resolved], ambiguous };
}

/**
 * PHASE 2 ONLY. Score a stored prediction against what actually changed.
 *
 * A change counts as predicted if the learner's raw text references any of its
 * aliases (authored or derived) or if its path was resolved from the repo map
 * in Phase 1.
 *
 * `spurious` is a file the learner named that did not change. It is not a
 * mistake to be punished; it is the most useful thing to talk about, because it
 * is where their model of the repo and the repo disagree.
 *
 * @param {{text: string, resolved?: string[]}} prediction
 * @param {Array<{path: string, aliases?: string[], inPlan: boolean}>} changes
 * @param {string[]} [repoMap] used to spot named-but-unchanged files
 * @returns {{
 *   hit: string[], missed: string[], spurious: string[],
 *   unplannedMissed: string[], score: {predicted: number, total: number}
 * }}
 */
export function scorePrediction(prediction, changes, repoMap = []) {
  const hay = normalise(prediction.text || '');
  const resolved = new Set(prediction.resolved || []);

  const hit = [];
  const missed = [];

  for (const change of changes) {
    const aliases = [...deriveAliases(change.path), ...(change.aliases || []).map((a) => a.toLowerCase())];
    const named = resolved.has(change.path) || aliases.some((a) => references(hay, a));
    (named ? hit : missed).push(change.path);
  }

  const changedPaths = new Set(changes.map((c) => c.path));
  const spurious = repoMap
    .filter((p) => !changedPaths.has(p))
    .filter((p) => resolved.has(p) || deriveAliases(p).some((a) => references(hay, a)));

  // Files the agent added on its own are reported separately: a learner cannot
  // be expected to predict them, so they are a disclosure, not a miss.
  const unplannedMissed = missed.filter(
    (p) => changes.find((c) => c.path === p)?.inPlan === false,
  );

  const plannedTotal = changes.filter((c) => c.inPlan).length;
  const plannedHit = hit.filter(
    (p) => changes.find((c) => c.path === p)?.inPlan,
  ).length;

  return {
    hit,
    missed: missed.filter((p) => !unplannedMissed.includes(p)),
    spurious,
    unplannedMissed,
    score: { predicted: plannedHit, total: plannedTotal },
  };
}
