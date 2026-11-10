/**
 * Agreement between your own labels and the judge's verdicts.
 *
 * Assignment 2 asks for percentage agreement and Cohen's kappa, and for both
 * before and after revising a judge prompt. Percentage alone is misleading on
 * an unbalanced set: if eighteen of twenty conversations pass, a judge that
 * says PASS to everything scores 90% while knowing nothing. Kappa corrects for
 * the agreement you would expect by chance.
 *
 * Your labels live in llm_judge/labels.csv, which you fill in yourself. The
 * brief is explicit that this judgement is yours, so nothing here writes to it.
 *
 * Usage:
 *   npm run judge:agreement
 *   npm run judge:agreement -- --criterion=c1 --cv=v1
 *
 * @module llm_judge/agreement
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');
// --labels=labels.raw.csv scores another label set without overwriting the
// default run's output: results go to agreement.<name>.json.
const LABELS_FILE = (process.argv.find((a) => a.startsWith('--labels=')) || '--labels=labels.csv').slice(9);
const LABELS = join(HERE, LABELS_FILE);
const OUT_NAME = LABELS_FILE === 'labels.csv'
  ? 'agreement.json'
  : `agreement.${LABELS_FILE.replace(/^labels\./, '').replace(/\.csv$/, '')}.json`;

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

/**
 * Cohen's kappa for two raters on a binary label.
 *
 *   kappa = (po - pe) / (1 - pe)
 *
 * where po is observed agreement and pe is the agreement expected if both
 * raters were guessing with their own marginal rates.
 *
 * Returns 1 when the raters agree perfectly, 0 when they agree no more than
 * chance, and a negative number when they agree less than chance. If one rater
 * used only one label, pe is 1 and kappa is undefined; that is reported as
 * null rather than as a number, because it is a fact about the test set rather
 * than about the judge.
 *
 * @param {Array<{mine: string, theirs: string}>} pairs
 * @returns {{n: number, po: number, pe: number, kappa: number|null, table: object}}
 */
export function cohensKappa(pairs) {
  const n = pairs.length;
  if (!n) return { n: 0, po: 0, pe: 0, kappa: null, table: {} };

  let bothPass = 0; let bothFail = 0; let mineOnly = 0; let theirsOnly = 0;
  for (const { mine, theirs } of pairs) {
    const m = mine === 'PASS';
    const t = theirs === 'PASS';
    if (m && t) bothPass += 1;
    else if (!m && !t) bothFail += 1;
    else if (m && !t) mineOnly += 1;
    else theirsOnly += 1;
  }

  const po = (bothPass + bothFail) / n;
  const minePass = (bothPass + mineOnly) / n;
  const theirsPass = (bothPass + theirsOnly) / n;
  const pe = minePass * theirsPass + (1 - minePass) * (1 - theirsPass);
  const kappa = pe === 1 ? null : (po - pe) / (1 - pe);

  return {
    n,
    po,
    pe,
    kappa,
    table: {
      bothPASS: bothPass,
      bothFAIL: bothFail,
      youPASS_judgeFAIL: mineOnly,
      youFAIL_judgePASS: theirsOnly,
    },
  };
}

/**
 * Read labels.csv: conversation,criterion,label
 * @returns {Map<string, string>} "c03|c1" -> "PASS"
 */
function readLabels() {
  if (!existsSync(LABELS)) {
    console.error(`\nNo labels file at llm_judge/labels.csv.`);
    console.error('Create it from labels.template.csv and fill in your own PASS/FAIL for');
    console.error('every conversation and criterion, before looking at the judge output.\n');
    process.exit(1);
  }
  const map = new Map();
  const lines = readFileSync(LABELS, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines.slice(1)) {
    const [conversation, criterion, label] = line.split(',').map((s) => s.trim());
    if (!conversation || !criterion || !label) continue;
    if (!['PASS', 'FAIL'].includes(label.toUpperCase())) {
      console.error(`labels.csv: "${label}" is not PASS or FAIL (${conversation} ${criterion})`);
      process.exit(1);
    }
    map.set(`${conversation}|${criterion}`, label.toUpperCase());
  }
  return map;
}

function main() {
  const labels = readLabels();
  const wantCriterion = arg('criterion', null);
  const wantVersion = arg('cv', null);

  const files = readdirSync(RESULTS).filter((f) => f.endsWith('.json') && !f.startsWith('agreement'));
  if (!files.length) {
    console.error('No judge results. Run: npm run judge:run');
    process.exit(1);
  }

  const report = [];

  for (const file of files.sort()) {
    const res = JSON.parse(readFileSync(join(RESULTS, file), 'utf8'));
    if (wantCriterion && res.criterion !== wantCriterion) continue;
    if (wantVersion && res.criterionVersion !== wantVersion) continue;

    const pairs = [];
    const disagreements = [];
    const missing = [];

    for (const row of res.rows) {
      const mine = labels.get(`${row.conversation}|${res.criterion}`);
      if (!mine) { missing.push(row.conversation); continue; }
      if (row.verdict === 'ERROR') continue;
      pairs.push({ mine, theirs: row.verdict });
      if (mine !== row.verdict) {
        disagreements.push({
          conversation: row.conversation,
          persona: row.persona,
          you: mine,
          judge: row.verdict,
          judgeReason: row.reason,
          judgeQuote: row.quote,
        });
      }
    }

    const k = cohensKappa(pairs);
    const entry = {
      criterion: res.criterion,
      criterionVersion: res.criterionVersion,
      judgeModel: res.judgeModel,
      n: k.n,
      percentAgreement: k.po,
      expectedByChance: k.pe,
      kappa: k.kappa,
      confusion: k.table,
      disagreements,
      unlabelled: missing,
    };
    report.push(entry);

    console.log(`\n${res.criterion} ${res.slug} (${res.criterionVersion}, judge ${res.judgeModel})`);
    console.log(`  n = ${k.n}`);
    console.log(`  agreement        ${(k.po * 100).toFixed(1)}%`);
    console.log(`  expected by chance ${(k.pe * 100).toFixed(1)}%`);
    console.log(`  Cohen's kappa    ${k.kappa === null ? 'undefined (one rater used a single label)' : k.kappa.toFixed(3)}`);
    console.log(`  confusion        ${JSON.stringify(k.table)}`);
    if (missing.length) console.log(`  unlabelled       ${missing.join(', ')}`);
    for (const d of disagreements) {
      console.log(`  disagree ${d.conversation} (${d.persona}): you ${d.you}, judge ${d.judge}`);
      console.log(`    judge said: ${d.judgeReason}`);
    }
  }

  writeFileSync(join(RESULTS, OUT_NAME), JSON.stringify({
    computedAt: new Date().toISOString(),
    labels: LABELS_FILE,
    interpretation: 'kappa: <0.20 slight, 0.21-0.40 fair, 0.41-0.60 moderate, 0.61-0.80 substantial, >0.80 almost perfect (Landis and Koch 1977)',
    report,
  }, null, 2), 'utf8');

  console.log(`\nLabels: ${LABELS_FILE}. Written to llm_judge/results/${OUT_NAME}\n`);
}

// Only run when invoked directly, so cohensKappa() can be unit tested.
if (resolve(fileURLToPath(import.meta.url)) === resolve(argv[1] || '')) {
  main();
}
