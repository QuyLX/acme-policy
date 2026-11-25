// Group "verification-core" of tech-design 13 (showcase completion): SC-06, SC-19, SC-21 profile-layers-conflict.
// Each group owns this file only; lib/modules/index.mjs merges the four groups and rejects duplicate keys.
//
// KINDS  — showcase run kinds: (run) => observed, where observed is
//          { checks: CheckResult[], exitCode?, requiredUnmet?, taskState?, decision?, dispositions?, notAssessed? }.
//          `notAssessed: '<reason>'` reports the case NOT_ASSESSED (never PASS) when the harness cannot observe the layer
//          (Standard §8.7 rule 3).
// CHECKS — registry checks without an adapter or command: (def, ctx) => CheckResult, where ctx is
//          { repo?, base?, changed?, diff?, readFile?, config?, executor?, input? } (`input` is a file path).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyPath, readJson, readYaml } from '../io.mjs';
import { validate } from '../schema.mjs';
import { checkDef } from '../registry.mjs';
import { deriveTask } from '../task-runner.mjs';
import { loadPlaybook, readEvents, workflowConformanceCheck } from '../../checks/workflow/conformance.mjs';
import { flakyPolicyCheck, loadFlakyRegistry, runWithRetry, stressRun } from '../flaky.mjs';
import { runIncidentRegression } from '../incident-regression.mjs';
import { readTestFiles, trace } from '../trace.mjs';
import { profileResolveCheck, resolutionEvidence } from '../resolve.mjs';
import { checkResult, runExitCode } from '../result.mjs';

const GIT = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];

/** Runs fn(dir) in a temp copy of a fixture repo, with an optional change applied. */
function inCopy(repo, change, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'acme-vc-'));
  try {
    cpSync(policyPath(repo), dir, { recursive: true });
    if (change) {
      const r = spawnSync('git', [...GIT, 'apply', policyPath(change)], { cwd: dir, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git apply ${change}: ${r.stderr}`);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- SC-06 flaky policy (Standard §7.14; FE §8.8) ----

/** The real test runs once and, if it fails, is retried once with the next seed; the attempts are then classified. */
function flakyRerun(run) {
  const attempts = inCopy(run.repo, run.change, (dir) => runWithRetry({ cwd: dir, file: run.test, seed: run.seed ?? 0 }));
  const input = { at: run.at, baseRegistry: run.registry, reruns: [{ testId: run.testId, checkId: 'quality.test', attempts }] };
  return { checks: [flakyPolicyCheck(checkDef('quality.flaky-policy'), input)] };
}

/** Stress mode: the real test runs 5 times with iteration-derived seeds (FE §8.8). */
function flakyStress(run) {
  const results = inCopy(run.repo, run.change, (dir) => stressRun({ cwd: dir, file: run.test, n: run.iterations ?? 5 }));
  return { checks: [flakyPolicyCheck(checkDef('quality.flaky-policy'), { at: run.at, stress: [{ testId: run.testId, results }] })] };
}

/** workflow.conformance on a task log, with a fixture flaky registry in place of the central one. */
function flakyTask(run) {
  const r = workflowConformanceCheck(checkDef('workflow.conformance'), readEvents(policyPath(run.events)), {
    extraDirs: run.playbooks ? [policyPath(run.playbooks)] : [],
    flakyRegistry: loadFlakyRegistry(policyPath(run.flakyRegistry)),
  });
  return { checks: [r], taskState: r.extensions?.['x-task']?.state };
}

function flakyPolicy(run) {
  return { checks: [flakyPolicyCheck(checkDef('quality.flaky-policy'), readYaml(policyPath(run.input)))] };
}

// ---- SC-19 incident → regression → trace (FE §7.7, §9.10) ----

function incidentRegression(run) {
  const r = runIncidentRegression(run);
  return { checks: r.checks };
}

/** `factory trace` over recorded VerificationRuns (the evidence store stand-in). */
function traceKind(run) {
  const root = policyPath(run.repo);
  const t = trace(run.ref, {
    journeys: readYaml(join(root, 'journeys.yaml')),
    testFiles: readTestFiles([join(root, run.tests ?? 'src')], root),
    runs: (run.runs ?? []).map((p) => readJson(policyPath(p))),
  });
  const blockers = t.findings.filter((f) => f.severity === 'BLOCKER');
  return { checks: [{ checkId: 'factory.trace', status: t.complete && !blockers.length ? 'PASS' : 'FAIL', findings: t.findings, extensions: { 'x-trace': t.chain } }] };
}

// ---- SC-21 profile-layer resolution (Standard §7.3; FE §8.3, Appendix A) ----

/** A temp git copy of the profile-layers fixture: the repository the resolution runs for (a real commit as subject). */
function inProfileRepo(fn) {
  return inCopy('showcase/fixtures/profile-layers', null, (dir) => {
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'profile layers']]) {
      const g = spawnSync('git', [...GIT, ...args], { cwd: dir, encoding: 'utf8' });
      if (g.status !== 0) throw new Error(`git ${args[0]}: ${g.stderr}`);
    }
    return fn(dir, spawnSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).stdout.trim());
  });
}

/** The real pipeline: `acme-policy run --checks profile.resolve --input <file>` (CI executor, real clock). */
function resolveThroughCli(input) {
  return inProfileRepo((dir) => {
    const args = [policyPath('bin', 'acme-policy.mjs'), 'run', '--repo', dir, '--base', 'HEAD', '--checks', 'profile.resolve', '--input', policyPath(input)];
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, FACTORY_EXECUTOR: 'ci' }, maxBuffer: 64 * 1024 * 1024 });
    if (!r.stdout) throw new Error(`acme-policy run produced no output: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
    return { exitCode: r.status, vr: JSON.parse(r.stdout) };
  });
}

/**
 * In-process, at the harness clock `now` (a code option: the CLI reads the real clock and has no clock option). The
 * run's resolution part is assembled by resolutionEvidence, the function `acme-policy run` uses.
 */
function resolveAtClock(input, now) {
  const { result } = profileResolveCheck(checkDef('profile.resolve'), readYaml(policyPath(input)), { now });
  const stamp = new Date().toISOString();
  return inProfileRepo((_dir, sha) => ({
    exitCode: runExitCode([result]),
    vr: {
      schemaVersion: 'aisf/4.0',
      runId: 'sc-21-resolve',
      workItemId: 'SC-21',
      channel: 'code',
      subject: { repo: 'profile-layers', commitSha: sha, baseSha: sha },
      ...resolutionEvidence([result]),
      environment: { executor: 'ci' },
      checks: [result],
      summary: { byStatus: { [result.status]: 1 }, requiredUnmet: [] },
      provenance: { factoryVersion: '0.1.0', verifierRef: 'acme-policy@showcase', producer: { ciJob: 'showcase' }, startedAt: stamp, finishedAt: stamp },
    },
  }));
}

/** What the evidence says about the resolution: layers and one `<checkId>.<parameter>: <how resolved>` per conflict. */
function resolutionDecision(vr) {
  const r = vr.resolution;
  return {
    inEvidence: Boolean(r),
    resolvedProfiles: (vr.resolvedProfiles ?? []).map((p) => `${p.id}@${p.version}`),
    layers: (r?.layers ?? []).map((l) => `${l.layer}:${l.id}@${l.version}`),
    conflicts: (r?.conflicts ?? []).map((c) => `${c.checkId}.${c.parameter}: ${c['x-fe']?.state ?? c.resolvedBy}${c.decisionRef ? ` (${c.decisionRef})` : ''}`),
    clock: vr.checks.find((c) => c.checkId === 'profile.resolve')?.extensions?.['x-blocking-switch'],
  };
}

/**
 * SC-21: resolves the layers, takes the resolution trace from the VerificationRun (validated against the schema) and
 * feeds a `profile.resolved` event built from that evidence to the task runner, which moves the task to BLOCKED when
 * the resolution failed. Without `run.now` the evidence is the real `acme-policy run` output; with `run.now` (harness
 * clock) the check runs in-process and the run's resolution is assembled by the same resolutionEvidence.
 */
function profileResolve(run) {
  const { exitCode, vr } = run.now ? resolveAtClock(run.input, run.now) : resolveThroughCli(run.input);
  const errors = validate('verification-run', vr);
  if (errors.length) throw new Error(`VerificationRun with resolution: ${errors.join('; ')}`);
  const decision = resolutionDecision(vr);
  let taskState;
  if (run.events) {
    // Platform-binding stand-in: the binding records the resolver's outcome as a task event; here it is built from the
    // run's evidence (`resolution`), not from the check internals.
    const events = readEvents(policyPath(run.events));
    const last = events.at(-1);
    const conflicts = vr.resolution?.conflicts ?? [];
    events.push({ workItemId: last.workItemId, at: new Date(Date.parse(last.at) + 60000).toISOString(), actor: { id: 'ci:resolver', kind: 'ci' }, type: 'profile.resolved', data: { blocked: conflicts.some((c) => c['x-fe']?.state === 'blocked'), conflicts, layers: vr.resolution?.layers ?? [] } });
    const ref = events.find((e) => e.type === 'task.requested').data.workflow;
    taskState = deriveTask(events, loadPlaybook(ref)).task.state;
  }
  return { checks: vr.checks, exitCode, taskState, decision };
}

export const KINDS = {
  'flaky-rerun': flakyRerun,
  'flaky-stress': flakyStress,
  'flaky-task': flakyTask,
  'flaky-policy': flakyPolicy,
  'incident-regression': incidentRegression,
  trace: traceKind,
  'profile-resolve': profileResolve,
};

export const CHECKS = {
  'quality.flaky-policy': (def, ctx) => flakyPolicyCheck(def, readYaml(ctx.input)),
  'profile.resolve': (def, ctx) =>
    ctx.input ? profileResolveCheck(def, readYaml(ctx.input)).result : checkResult(def, { status: 'NOT_ASSESSED', reason: 'no profile-layers input (--input): the request names the layers to resolve' }),
};
