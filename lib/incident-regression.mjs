// SC-19 (FE §20.3; CORE-VER-04): incident → reproduction → fix → evidence → trace, on a temp git copy of a fixture.
// The reproduction (oracle) test must fail on the faulty commit and pass on the fix (FE §9.10 regression item 1;
// Standard §6.4.1 item 7); each run becomes a VerificationRun bound to its commit, carrying the test cases it ran and
// the journeys/scenarios/ACs they cover (FE §8.5 `x-fe`); `trace` then follows requirement → AC → test → PASS evidence.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyPath, readYaml } from './io.mjs';
import { validate } from './schema.mjs';
import { checkDef } from './registry.mjs';
import { checkResult } from './result.mjs';
import { childTestEnv } from './flaky.mjs';
import { readTestFiles, testCasesFrom, trace } from './trace.mjs';

const GIT = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];
function git(cwd, args) {
  const r = spawnSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Runs a node:test file with the TAP reporter; returns { exitCode, results: [{ title, status }] }. */
export function runOracle(cwd, file) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd, encoding: 'utf8', env: childTestEnv() });
  const results = [];
  for (const m of r.stdout.matchAll(/^\s*(not )?ok \d+ - (.+?)\s*$/gm)) {
    if (m[2] === file || m[2].endsWith('.mjs')) continue; // file-level summary line of some reporters
    results.push({ title: m[2].replace(/\s+#\s+(SKIP|TODO).*$/, ''), status: m[1] ? 'FAIL' : 'PASS' });
  }
  return { exitCode: r.status, results };
}

/** A VerificationRun (Standard Appendix K.2) for one oracle run on one commit. */
export function oracleRun({ runId, workItemId, repo, commitSha, baseSha, file, cases, results, at }) {
  const byTitle = new Map(results.map((r) => [r.title, r.status]));
  const tested = cases.filter((c) => c.file === file);
  const testCases = tested.map((c) => ({ id: c.id, file: c.file, title: c.title, status: byTitle.get(c.title) ?? 'NOT_ASSESSED' }));
  const status = testCases.length && testCases.every((t) => t.status === 'PASS') ? 'PASS' : 'FAIL';
  const uniq = (xs) => [...new Set(xs)];
  const check = checkResult(checkDef('quality.test'), {
    status,
    reason: status === 'PASS' ? undefined : `${testCases.filter((t) => t.status !== 'PASS').length} test case(s) did not pass`,
    command: `node --test ${file}`,
    extensions: {
      'x-fe': { evidenceLayer: 'static', ownership: 'local', lifecycle: 'active', journeys: uniq(tested.flatMap((c) => c.journeys)), scenarios: uniq(tested.flatMap((c) => c.scenarios)), acceptanceCriteria: uniq(tested.flatMap((c) => c.ac)) },
      'x-test-cases': testCases,
    },
  });
  check.requirementIds = uniq(tested.flatMap((c) => c.ac));
  return {
    schemaVersion: 'aisf/4.0',
    runId,
    workItemId,
    channel: 'code',
    subject: { repo, commitSha, baseSha },
    resolvedProfiles: [{ id: 'aisf-frontend', version: '1.1.0' }],
    environment: { executor: 'ci' },
    checks: [check],
    summary: { byStatus: { [status]: 1 }, requiredUnmet: status === 'PASS' ? [] : ['quality.test'] },
    provenance: { factoryVersion: '0.1.0', verifierRef: 'acme-policy@showcase', producer: { ciJob: 'showcase' }, startedAt: at, finishedAt: at },
  };
}

/**
 * @param {{ repo: string, fix: string, oracle: string, ref: string, ac: string, workItemId?: string }} run
 *   (the faulty run has baseSha = commitSha: the oracle runs on the faulty commit itself)
 * @returns {{ checks: object[], runs: object[] }}
 */
export function runIncidentRegression({ repo, fix, oracle, ref, ac, workItemId = 'SC-19' }) {
  const dir = mkdtempSync(join(tmpdir(), 'acme-incident-'));
  const problems = [];
  try {
    cpSync(policyPath(repo), dir, { recursive: true });
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'faulty commit (incident)']);
    const faultySha = git(dir, ['rev-parse', 'HEAD']);
    const cases = testCasesFrom(readTestFiles([join(dir, oracle)], dir));
    const reproduction = cases.filter((c) => c.ac.includes(ac));
    if (!reproduction.length) problems.push(`no oracle test is tagged @ac:${ac}`);

    const before = runOracle(dir, oracle);
    const failedBefore = reproduction.filter((c) => before.results.find((r) => r.title === c.title)?.status === 'FAIL');
    if (reproduction.length && failedBefore.length !== reproduction.length) problems.push(`the reproduction test for ${ac} does not fail on the faulty commit ${faultySha.slice(0, 12)}`);
    const t0 = new Date().toISOString();
    const faultyRun = oracleRun({ runId: `${workItemId.toLowerCase()}-faulty`, workItemId, repo: repo.split('/').pop(), commitSha: faultySha, baseSha: faultySha, file: oracle, cases, results: before.results, at: t0 });

    git(dir, ['apply', policyPath(fix)]);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'fix']);
    const fixSha = git(dir, ['rev-parse', 'HEAD']);
    const after = runOracle(dir, oracle);
    if (after.exitCode !== 0) problems.push(`the oracle fails on the fix commit ${fixSha.slice(0, 12)}`);
    const t1 = new Date(Date.parse(t0) + 1000).toISOString();
    const fixRun = oracleRun({ runId: `${workItemId.toLowerCase()}-fix`, workItemId, repo: repo.split('/').pop(), commitSha: fixSha, baseSha: faultySha, file: oracle, cases, results: after.results, at: t1 });
    for (const r of [faultyRun, fixRun]) for (const e of validate('verification-run', r)) problems.push(`VerificationRun ${r.runId}: ${e}`);
    if (fixRun.subject.commitSha !== fixSha) problems.push('the VerificationRun is not bound to the fix commit');

    const t = trace(ref, { journeys: readYaml(join(dir, 'journeys.yaml')), testFiles: readTestFiles([join(dir, oracle)], dir), runs: [faultyRun, fixRun] });
    const traceProblems = t.findings.filter((f) => f.severity === 'BLOCKER');
    return {
      runs: [faultyRun, fixRun],
      trace: t,
      checks: [
        {
          checkId: 'showcase.regression-reproduction',
          status: problems.length ? 'FAIL' : 'PASS',
          findings: [{ ruleId: 'showcase.regression-reproduction', message: problems.join('; ') || `${ac}: FAIL on faulty ${faultySha.slice(0, 12)}, PASS on fix ${fixSha.slice(0, 12)}` }],
          extensions: { 'x-commits': { faulty: faultySha, fix: fixSha } },
        },
        { checkId: 'factory.trace', status: t.complete && !traceProblems.length ? 'PASS' : 'FAIL', findings: t.findings, extensions: { 'x-trace': t.chain } },
      ],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
