// Flaky check policy (Standard §7.14 items 1-9; FE §8.8 "Flakiness"; Standard Appendix K.2 CheckResult.attempts
// and CheckResult.flaky). SC-06 / CORE-VER-09.
//   - Only pre-existing instability counts as flaky: a test is flaky only when it is in the flaky registry (item 1).
//   - Fail-then-pass on the automatic retry, not registered → FAIL `flaky.new-nondeterminism` (item 2).
//   - At most one automatic retry, both results recorded (FE §8.8; item 7) → `extensions['x-reruns']`.
//   - A retry ending in ERROR is an infrastructure event, not a flake (item 9) → ERROR `flaky.infra`.
//   - Quarantine is decided by the owner only, never by the agent working on the task (item 4) →
//     FAIL `flaky.quarantine-owner`.
//   - Stress mode: tests of touched code in timing-sensitive areas run repeatedly before review (item 3;
//     FE §8.8 suggests 5×) → any failing iteration is FAIL `flaky.stress-reproduced`.
import { spawnSync } from 'node:child_process';
import { readYaml, policyPath } from './io.mjs';
import { validate } from './schema.mjs';
import { checkResult } from './result.mjs';

export const MAX_AUTOMATIC_RETRIES = 1; // FE §8.8
export const STRESS_ITERATIONS = 5; // FE §8.8 (suggested)

const isAgent = (id) => typeof id === 'string' && id.startsWith('agent:');
const day = (s) => String(s).slice(0, 10);

/** Loads and validates a FlakyRegistry (default: the central registry/flaky.yaml). */
export function loadFlakyRegistry(path = policyPath('registry', 'flaky.yaml')) {
  const registry = readYaml(path);
  const errors = validate('flaky-registry', registry);
  if (errors.length) throw new Error(`${path}: ${errors.join('; ')}`);
  return registry;
}

/** Problems of one registry entry that make it an invalid quarantine (Standard §7.14 items 4-5). */
export function entryProblems(entry) {
  const problems = [];
  if (entry.decidedBy !== entry.owner) problems.push(`quarantine ${entry.quarantineId} was decided by ${entry.decidedBy}, not by the owner ${entry.owner} (Standard §7.14 item 4)`);
  if (isAgent(entry.owner) || isAgent(entry.decidedBy)) problems.push(`quarantine ${entry.quarantineId}: an agent cannot own or decide a quarantine (Standard §7.14 item 4; FE §9.10)`);
  return problems;
}

/**
 * The registry entry that makes `testId` a registered flake at time `at`, or null. An entry decided by someone other
 * than the owner, or past its fix-by date, does not count.
 */
export function registeredEntry(registry, testId, { checkId, at } = {}) {
  const entry = (registry?.entries ?? []).find((e) => e.testId === testId && (!checkId || e.checkId === checkId));
  if (!entry || entryProblems(entry).length) return null;
  if (at && day(at) > day(entry.fixBy)) return null;
  return entry;
}

/**
 * Classifies the attempts of one test (the first run plus at most one automatic retry).
 * @param {{ testId: string, checkId?: string, attempts: Array<'PASS'|'FAIL'|'ERROR'>, registry?: object, at?: string }} input
 * @returns {{ status: 'PASS'|'FAIL'|'ERROR', attempts: number, flaky?: { registered: boolean, quarantineId?: string },
 *             findings: object[], extensions: { 'x-reruns': Array<{ attempt: number, status: string }> } }}
 */
export function classifyRerun({ testId, checkId, attempts, registry, at }) {
  if (!attempts?.length) throw new Error(`classifyRerun: no attempts for ${testId}`);
  const reruns = attempts.map((status, i) => ({ attempt: i + 1, status }));
  const out = (status, ruleId, severity, message, flaky) => ({
    status,
    attempts: attempts.length,
    ...(flaky ? { flaky } : {}),
    findings: ruleId ? [{ source: 'check', ruleId, severity, location: testId, message, state: 'open' }] : [],
    extensions: { 'x-reruns': reruns },
  });
  const last = attempts.at(-1);
  if (attempts.length > MAX_AUTOMATIC_RETRIES + 1) return out('FAIL', 'flaky.retry-limit', 'BLOCKER', `${attempts.length} attempts: at most ${MAX_AUTOMATIC_RETRIES} automatic retry is allowed (FE §8.8)`);
  if (last === 'ERROR') return out('ERROR', 'flaky.infra', 'WARNING', `the ${attempts.length > 1 ? 'retry' : 'run'} ended in ERROR: an infrastructure event, not a flake; reported to the check owner (Standard §7.14 item 9)`);
  if (last === 'PASS' && attempts.length === 1) return out('PASS');
  const entry = registeredEntry(registry, testId, { checkId, at });
  if (last === 'PASS') {
    if (entry) return out('PASS', 'flaky.registered', 'INFO', `fail-then-pass on a registered flake (quarantine ${entry.quarantineId}, owner ${entry.owner}); both results recorded`, { registered: true, quarantineId: entry.quarantineId });
    return out('FAIL', 'flaky.new-nondeterminism', 'BLOCKER', 'failed, then passed on rerun, and is not in the flaky registry: new non-determinism is a FAIL (Standard §7.14 item 2; FE §8.8)', { registered: false });
  }
  if (entry) return out('FAIL', 'flaky.quarantined-failure', 'INFO', `failed on every attempt; quarantined (${entry.quarantineId}): reported, excluded from blocking and from triggering repair (Standard §7.14 item 5)`, { registered: true, quarantineId: entry.quarantineId });
  return out('FAIL', 'test.failed', 'BLOCKER', `failed on all ${attempts.length} attempt(s)`, { registered: false });
}

/** Environment for a child `node --test`: the parent test runner's variables would make it report to the parent. */
export function childTestEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('NODE_TEST') || key === 'NODE_CHANNEL_FD') delete env[key];
  return { ...env, ...extra };
}

/** Runs one test file once with a seed; returns PASS, FAIL or ERROR (the process could not run the tests). */
export function runTestOnce({ cwd, file, seed }) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd, encoding: 'utf8', env: childTestEnv({ ACME_STRESS_SEED: String(seed) }) });
  if (r.error || r.status === null) return 'ERROR';
  if (r.status === 0) return 'PASS';
  return /^\s*not ok \d+/m.test(r.stdout) ? 'FAIL' : 'ERROR';
}

/**
 * The first run plus at most one automatic retry (FE §8.8). The harness derives the seed from the attempt number, so
 * the interleaving of a racy test differs between the run and the retry, as it would on a real runner.
 */
export function runWithRetry({ cwd, file, seed = 0 }) {
  const attempts = [runTestOnce({ cwd, file, seed })];
  if (attempts[0] !== 'PASS') attempts.push(runTestOnce({ cwd, file, seed: seed + 1 }));
  return attempts;
}

/** Stress mode (Standard §7.14 item 3; FE §8.8): runs the test `n` times with iteration-derived seeds. */
export function stressRun({ cwd, file, n = STRESS_ITERATIONS, seedBase = 0 }) {
  return Array.from({ length: n }, (_, i) => ({ iteration: i + 1, seed: seedBase + i, status: runTestOnce({ cwd, file, seed: seedBase + i }) }));
}

/** Verdict of a stress run: FAIL when any iteration fails, ERROR when an iteration could not run. */
export function classifyStress({ testId, results }) {
  const failed = results.filter((r) => r.status === 'FAIL');
  const errored = results.filter((r) => r.status === 'ERROR');
  if (failed.length) return { status: 'FAIL', findings: [{ source: 'check', ruleId: 'flaky.stress-reproduced', severity: 'BLOCKER', location: testId, message: `stress mode reproduced a failure in ${failed.length}/${results.length} iterations (${failed.map((r) => `#${r.iteration}`).join(', ')}): timing-dependent behavior in touched code (Standard §7.14 item 3; FE §8.8)`, state: 'open' }] };
  if (errored.length) return { status: 'ERROR', findings: [{ source: 'check', ruleId: 'flaky.infra', severity: 'WARNING', location: testId, message: `${errored.length} stress iteration(s) ended in ERROR (Standard §7.14 item 9)`, state: 'open' }] };
  return { status: 'PASS', findings: [] };
}

const EMPTY_REGISTRY = { apiVersion: 'aisf/4.0', kind: 'FlakyRegistry', entries: [] };
const asRegistry = (r) => (typeof r === 'string' ? readYaml(policyPath(r)) : r ?? EMPTY_REGISTRY);

/**
 * quality.flaky-policy: evaluates a flaky registry change, rerun records and stress runs.
 * input: { at?, change?: { actor: { id, kind } }, baseRegistry?, headRegistry?, reruns?: [{ testId, checkId, attempts }],
 *          stress?: [{ testId, results: [{ iteration, status }] }] }   (registries inline or as policy-relative paths)
 */
export function flakyPolicyCheck(def, input) {
  const started = Date.now();
  const findings = [];
  const f = (ruleId, severity, location, message) => findings.push({ source: 'check', ruleId, severity, location, message, state: 'open' });
  const base = asRegistry(input.baseRegistry);
  const head = asRegistry(input.headRegistry ?? input.baseRegistry);
  const schemaErrors = validate('flaky-registry', head);
  for (const e of schemaErrors) f('flaky.registry-schema', 'BLOCKER', 'registry/flaky.yaml', e);
  const baseIds = new Set((base.entries ?? []).map((e) => e.quarantineId));
  for (const entry of head.entries ?? []) {
    for (const p of entryProblems(entry)) f('flaky.quarantine-owner', 'BLOCKER', entry.testId, p);
    const added = !baseIds.has(entry.quarantineId);
    if (added && (input.change?.actor?.kind === 'agent' || isAgent(input.change?.actor?.id))) {
      f('flaky.quarantine-owner', 'BLOCKER', entry.testId, `quarantine ${entry.quarantineId} was added by ${input.change.actor.id}: the agent working on the task must not quarantine a test (Standard §7.14 item 4; FE §8.8)`);
    }
    if (input.at && day(input.at) > day(entry.fixBy)) f('flaky.quarantine-expired', 'WARNING', entry.testId, `quarantine ${entry.quarantineId} passed its fix-by date ${day(entry.fixBy)}: the test blocks again (Standard §7.14 item 5)`);
  }
  const reruns = [];
  for (const r of input.reruns ?? []) {
    const c = classifyRerun({ ...r, registry: head, at: input.at });
    reruns.push({ testId: r.testId, status: c.status, flaky: c.flaky, attempts: c.extensions['x-reruns'] });
    // A consistent failure is quality.test's FAIL, not a flaky-policy violation: shown for context only.
    findings.push(...c.findings.map((x) => (x.ruleId === 'test.failed' ? { ...x, severity: 'INFO' } : x)));
  }
  const stress = [];
  for (const s of input.stress ?? []) {
    const c = classifyStress(s);
    stress.push({ testId: s.testId, status: c.status, results: s.results });
    findings.push(...c.findings);
  }
  const blockers = findings.filter((x) => x.severity === 'BLOCKER');
  const infra = findings.some((x) => x.ruleId === 'flaky.infra');
  const blocking = def.enforcement === 'blocking';
  const status = blockers.length && blocking ? 'FAIL' : infra ? 'ERROR' : 'PASS';
  const shown = blocking ? findings : findings.map((x) => ({ ...x, severity: x.severity === 'BLOCKER' ? (def.enforcement === 'warn' ? 'WARNING' : 'INFO') : x.severity }));
  return checkResult(def, {
    status,
    reason: status === 'PASS' ? undefined : status === 'ERROR' ? 'a rerun ended in ERROR (infrastructure, Standard §7.14 item 9)' : blockers.map((x) => x.ruleId).filter((v, i, a) => a.indexOf(v) === i).join(', '),
    findings: shown,
    attempts: Math.max(1, ...reruns.map((r) => r.attempts.length)),
    durationMs: Date.now() - started,
    extensions: { 'x-reruns': reruns, 'x-stress': stress },
  });
}

/**
 * Task-runner hook (Standard §7.14 item 5): a verify FAIL whose failing tests are all registered flakes with a valid
 * quarantine does not trigger repair and does not consume `verifyRepairIterations`. The failing tests come from the
 * event (`data.failedTests`, recorded from the VerificationRun); the registry is never taken from the event.
 * @returns {null | { quarantineIds: string[], notice: string }}
 */
export function registeredFlakeFailure(event, registry) {
  const failed = event.data?.failedTests;
  if (!Array.isArray(failed) || !failed.length) return null;
  const reg = registry ?? loadFlakyRegistry();
  const entries = failed.map((t) => registeredEntry(reg, t, { checkId: event.data.checkId, at: event.at }));
  if (entries.some((e) => !e)) return null;
  const quarantineIds = entries.map((e) => e.quarantineId);
  return { quarantineIds, notice: `verify FAIL caused only by registered flake(s) ${quarantineIds.join(', ')}: excluded from repair and from the verify budget (Standard §7.14 item 5)` };
}
