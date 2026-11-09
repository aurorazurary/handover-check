/**
 * Run the LLM judge over the generated conversations.
 *
 * One criterion per call. A single prompt asked to score three criteria at
 * once tends to let a strong verdict on one drag the others with it, and it
 * makes disagreement with your own labels impossible to attribute.
 *
 * The judge runs on a model named separately from the system under test
 * (HC_JUDGE_MODEL), because a judge that shares the system's blind spots will
 * not find them.
 *
 * Usage:
 *   npm run judge:run                             every criterion, every conversation
 *   npm run judge:run -- --criterion=c1 --cv=v2   one criterion at a given prompt version
 *   npm run judge:run -- --only=c03
 *
 * Output: llm_judge/results/<criterion>.<promptVersion>.json
 *
 * @module llm_judge/run_judge
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { completeJSON, providerInfo } from '../src/llm/provider.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONVOS = join(HERE, 'conversations');
const CRITERIA = join(HERE, 'criteria');
const RESULTS = join(HERE, 'results');

const JUDGE_MODEL = process.env.HC_JUDGE_MODEL || process.env.HC_MODEL || 'claude-sonnet-5';

const arg = (n, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};

/** Criteria available on disk, keyed by id, each with its versions. */
export function availableCriteria() {
  /** @type {Record<string, {slug: string, versions: string[]}>} */
  const out = {};
  for (const f of readdirSync(CRITERIA).filter((x) => x.endsWith('.md'))) {
    const m = f.match(/^(c\d+)_(.+)\.(v\d+)\.md$/);
    if (!m) continue;
    const [, id, slug, version] = m;
    out[id] ||= { slug, versions: [] };
    out[id].versions.push(version);
  }
  for (const v of Object.values(out)) v.versions.sort();
  return out;
}

/**
 * Format a transcript for the judge. Turn indices and states are included
 * because the criteria refer to both.
 *
 * @param {any} convo
 */
function renderTranscript(convo) {
  return convo.transcript
    .filter((t) => t.role !== 'system')
    .map((t, i) => `[${i}] (${t.state}) ${t.role === 'cui' ? 'SYSTEM' : 'LEARNER'}: ${t.content}`)
    .join('\n\n');
}

/**
 * @param {string} criterionId e.g. "c1"
 * @param {string} version e.g. "v1"
 * @param {any} convo
 */
async function judgeOne(criterionId, version, convo) {
  const { slug } = availableCriteria()[criterionId];
  const prompt = readFileSync(join(CRITERIA, `${criterionId}_${slug}.${version}.md`), 'utf8');

  const result = await completeJSON({
    system: prompt,
    messages: [{
      role: 'user',
      content: `Transcript to judge:\n\n${renderTranscript(convo)}`,
    }],
    model: JUDGE_MODEL,
    maxTokens: 6000,
    fallback: { verdict: 'ERROR', turnIndex: null, quote: '', reason: 'judge returned no JSON' },
  });

  return {
    conversation: convo.id,
    persona: convo.persona,
    scenario: convo.scenario,
    promptVersion: convo.promptVersion,
    expectFail: convo.expectFail,
    verdict: result.verdict,
    turnIndex: result.turnIndex ?? null,
    quote: result.quote ?? '',
    reason: result.reason ?? '',
  };
}

async function main() {
  if (!providerInfo().live) {
    console.error('Refusing to run: HC_PROVIDER is mock. The judge needs a real model.');
    process.exit(1);
  }
  if (!existsSync(CONVOS) || !readdirSync(CONVOS).length) {
    console.error('No conversations found. Run: npm run judge:conversations');
    process.exit(1);
  }
  if (!existsSync(RESULTS)) mkdirSync(RESULTS, { recursive: true });

  const criteria = availableCriteria();
  const wantCriterion = arg('criterion', null);
  const wantVersion = arg('cv', null);
  const only = arg('only', null);

  const convos = readdirSync(CONVOS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(CONVOS, f), 'utf8')))
    .filter((c) => !only || c.id === only)
    .sort((a, b) => a.id.localeCompare(b.id));

  console.log(`\nJudge model: ${JUDGE_MODEL}`);
  console.log(`Conversations: ${convos.length}\n`);

  for (const [id, meta] of Object.entries(criteria)) {
    if (wantCriterion && id !== wantCriterion) continue;
    const version = wantVersion || meta.versions[meta.versions.length - 1];
    if (!meta.versions.includes(version)) {
      console.error(`${id} has no ${version}. Available: ${meta.versions.join(', ')}`);
      continue;
    }

    console.log(`${id} ${meta.slug} (${version})`);
    const rows = [];
    for (const convo of convos) {
      const row = await judgeOne(id, version, convo);
      rows.push(row);
      const flag = row.verdict === 'FAIL' ? '\x1b[33mFAIL\x1b[0m' : row.verdict === 'PASS' ? 'PASS' : row.verdict;
      console.log(`  ${row.conversation}  ${flag}  ${row.reason.slice(0, 70)}`);
    }

    const passed = rows.filter((r) => r.verdict === 'PASS').length;
    const out = {
      criterion: id,
      slug: meta.slug,
      criterionVersion: version,
      judgeModel: JUDGE_MODEL,
      runAt: new Date().toISOString(),
      passRate: rows.length ? passed / rows.length : 0,
      counts: {
        pass: passed,
        fail: rows.filter((r) => r.verdict === 'FAIL').length,
        error: rows.filter((r) => r.verdict === 'ERROR').length,
      },
      rows,
    };
    writeFileSync(join(RESULTS, `${id}.${version}.json`), JSON.stringify(out, null, 2), 'utf8');
    console.log(`  pass rate ${(out.passRate * 100).toFixed(0)}%  ->  llm_judge/results/${id}.${version}.json\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
