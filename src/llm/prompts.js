/**
 * Prompt loading and templating.
 *
 * Prompts are files on disk, not string literals in code, for three reasons:
 * they can be read without reading JavaScript, they can be versioned as a set,
 * and a change to one shows up in `git diff` as a change to a prompt rather
 * than as a change to a function.
 *
 * The version is pinned by HC_PROMPT_VERSION (default v1). Assignment 2 asks
 * for every version of the judge prompts, so superseded versions stay in the
 * repository rather than being edited in place: prompts/v1, prompts/v2, and so
 * on. The results in llm_judge/results record which version produced them.
 *
 * @module llm/prompts
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_ROOT = join(HERE, '..', '..', 'prompts');

export const PROMPT_VERSION = process.env.HC_PROMPT_VERSION || 'v1';

/** @type {Map<string, string>} */
const cache = new Map();

/**
 * Read a prompt file, with {{PERSONA}} already substituted.
 *
 * @param {string} name file name without extension, e.g. "phase1_elicit"
 * @param {string} [version]
 * @returns {string}
 */
export function loadPrompt(name, version = PROMPT_VERSION) {
  const key = `${version}/${name}`;
  if (cache.has(key)) return cache.get(key);

  const path = join(PROMPT_ROOT, version, `${name}.md`);
  if (!existsSync(path)) {
    const available = existsSync(join(PROMPT_ROOT, version))
      ? readdirSync(join(PROMPT_ROOT, version)).join(', ')
      : '(no such version)';
    throw new Error(`No prompt "${name}" in prompts/${version}. Available: ${available}`);
  }

  let text = readFileSync(path, 'utf8');
  if (text.includes('{{PERSONA}}') && name !== 'persona') {
    text = text.replace('{{PERSONA}}', readFileSync(join(PROMPT_ROOT, version, 'persona.md'), 'utf8').trim());
  }
  cache.set(key, text);
  return text;
}

/**
 * Substitute {{PLACEHOLDERS}}. Throws on any placeholder left unfilled, because
 * a prompt that still contains "{{GAP}}" silently produces a worse reply, and
 * that is exactly the kind of failure that is hard to spot in a transcript.
 *
 * @param {string} template
 * @param {Record<string, string|number>} values
 * @returns {string}
 */
export function fill(template, values) {
  let out = template;
  for (const [k, v] of Object.entries(values)) {
    out = out.split(`{{${k}}}`).join(String(v ?? ''));
  }
  const leftover = out.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) {
    throw new Error(`Unfilled prompt placeholders: ${[...new Set(leftover)].join(', ')}`);
  }
  return out;
}

/**
 * Load and fill in one call.
 *
 * @param {string} name
 * @param {Record<string, string|number>} values
 * @param {string} [version] pinned per session, so one run can use the
 *   weakened v0 prompts while another uses v1
 * @returns {string}
 */
export function render(name, values, version = PROMPT_VERSION) {
  return fill(loadPrompt(name, version), values);
}

/** Which prompt versions exist, newest-looking last. */
export function listVersions() {
  return readdirSync(PROMPT_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
