// Runs checks against fixtures: the mechanism behind registry mutation proofs (FE §8.2 rule 1) and showcase scenarios.
//   { diff }      diff-based checks evaluated on a unified diff
//   { repo, change? }  the full `acme-policy run` pipeline on a temp git copy of a fixture repo (change applied uncommitted)
//   { sodInput }  policy.sod on a platform-neutral input
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, readText, policyPath, POLICY_ROOT } from './io.mjs';
import { checkDef, controlFileGlobs, integrityParams } from './registry.mjs';
import { scanDiff } from '../checks/integrity/scan.mjs';
import { sensorCheck } from '../checks/integrity/sensors.mjs';
import { injectionPrescanCheck } from '../checks/review/injection-prescan.mjs';
import { secretsCheck } from '../checks/sec/secrets.mjs';
import { sodCheck } from '../checks/policy-sod/evaluate.mjs';
import { readEvents, workflowConformanceCheck } from '../checks/workflow/conformance.mjs';

export const DIFF_CHECKS = [
  'integrity.test-count-delta', 'integrity.skip-focus', 'integrity.suppressions', 'integrity.snapshot-churn',
  'integrity.threshold-change', 'integrity.control-file-change', 'integrity.expected-value-edit', 'integrity.self-mocking',
  'integrity.vacuous-test', 'integrity.tolerance-inflation', 'integrity.broad-catch', 'integrity.oracle-lock',
  'review.injection-prescan', 'sec.secrets',
];

/** Diff-only evaluation (no repository content: control files are classified conservatively, by whole file). */
export function runDiffChecks(diffText, ids = DIFF_CHECKS) {
  const globs = controlFileGlobs();
  const hits = scanDiff(diffText, { params: integrityParams(), controlFileGlobs: globs });
  return ids.map((id) => {
    const def = checkDef(id);
    if (id === 'review.injection-prescan') return injectionPrescanCheck(def, diffText, globs);
    if (id === 'sec.secrets') return secretsCheck(def, diffText);
    return sensorCheck(def, hits);
  });
}

const SYNTHETIC_GIT = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];
function git(cwd, args) {
  const r = spawnSync('git', [...SYNTHETIC_GIT, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

export function runPipeline({ repo, change, checks, sodInput, executor = 'ci' }) {
  const dir = mkdtempSync(join(tmpdir(), 'acme-fixture-'));
  try {
    cpSync(policyPath(repo), dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'base']);
    if (change) git(dir, ['apply', policyPath(change)]);
    const args = [join(POLICY_ROOT, 'bin', 'acme-policy.mjs'), 'run', '--repo', dir, '--base', 'HEAD', '--checks', checks.join(',')];
    if (sodInput) args.push('--sod-input', policyPath(sodInput));
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, FACTORY_EXECUTOR: executor }, maxBuffer: 64 * 1024 * 1024 });
    const out = r.stdout ? JSON.parse(r.stdout) : null;
    if (!out) throw new Error(`acme-policy run produced no output: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
    return { exitCode: r.status, checks: out.checks, requiredUnmet: out.summary.requiredUnmet };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs one check on one fixture; returns its CheckResult. */
export function runFixture(checkId, fixture) {
  if (fixture.diff) return runDiffChecks(readText(policyPath(fixture.diff)), [checkId])[0];
  if (fixture.sodInput) return sodCheck(checkDef(checkId), readJson(policyPath(fixture.sodInput)));
  if (fixture.taskEvents) return workflowConformanceCheck(checkDef(checkId), readEvents(policyPath(fixture.taskEvents)), { extraDirs: fixture.playbooks ? [policyPath(fixture.playbooks)] : [] });
  if (fixture.repo) return runPipeline({ repo: fixture.repo, change: fixture.change, checks: [checkId] }).checks[0];
  throw new Error(`unsupported fixture for ${checkId}: ${JSON.stringify(fixture)}`);
}
