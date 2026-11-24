import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const POLICY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function readText(path) {
  return path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
}

export function readYaml(path) {
  return parseYaml(readText(path));
}

export function readJson(path) {
  return JSON.parse(readText(path));
}

export function policyPath(...parts) {
  return join(POLICY_ROOT, ...parts);
}

/** Splits a Markdown file into YAML frontmatter (object or null) and body. */
export function readFrontmatter(path) {
  const text = readText(path);
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { meta: null, body: text };
  return { meta: parseYaml(match[1]), body: text.slice(match[0].length) };
}
