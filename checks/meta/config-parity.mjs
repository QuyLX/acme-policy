// meta.config-parity — FE-CFG-001: lint/TS/test config in a product repo is generated from the pinned presets plus
// factory.config.yaml and never edited by hand; every workspace project is declared exactly once.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverProjects, hasNx } from '../../lib/workspace.mjs';
import { readProjectConfig } from '../../lib/kit.mjs';
import { kitRepoFiles, repoFiles } from '../../lib/config-gen.mjs';
import { checkResult } from '../../lib/result.mjs';

/** @returns {Array<{ location: string, message: string, expected?: string }>} problems; `expected` = content to write */
export function parityProblems(repo, kitVersion, kitDir) {
  const { config, errors } = readProjectConfig(repo);
  if (!config) return errors.map((message) => ({ location: 'factory.config.yaml', message }));
  const problems = [];
  const projects = discoverProjects(repo);
  const names = new Set(projects.map((p) => p.name));
  for (const p of projects) if (!config.projects[p.name]) problems.push({ location: `${p.dir}/package.json`, message: `project "${p.name}" is not declared in factory.config.yaml` });
  for (const name of Object.keys(config.projects)) if (!names.has(name)) problems.push({ location: 'factory.config.yaml', message: `"${name}" is declared but is not a workspace project` });
  const compare = (location, expected) => {
    const path = join(repo, location);
    const actual = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (actual === null) problems.push({ location, message: 'generated file is missing (run `factory sync`)', expected });
    else if (actual !== expected) problems.push({ location, message: 'differs from the generated content: edit factory.config.yaml and run `factory sync` instead (FE-CFG-001)', expected });
  };
  for (const [location, expected] of Object.entries(kitRepoFiles(kitDir, kitVersion))) compare(location, expected);
  for (const p of projects) {
    const entry = config.projects[p.name];
    if (!entry) continue;
    for (const [file, expected] of Object.entries(repoFiles(entry, { kitVersion, boundaries: hasNx(repo), projectDir: p.dir }))) compare(`${p.dir}/${file}`, expected);
  }
  return problems;
}

export function configParityCheck(def, repo, kitVersion, kitDir) {
  const started = Date.now();
  const problems = parityProblems(repo, kitVersion, kitDir);
  return checkResult(def, {
    status: problems.length ? 'FAIL' : 'PASS',
    reason: problems.length ? `${problems.length} config parity problem(s)` : undefined,
    findings: problems.map((p) => ({ source: 'check', ruleId: 'FE-CFG-001', severity: 'BLOCKER', location: p.location, message: p.message, state: 'open' })),
    durationMs: Date.now() - started,
  });
}
