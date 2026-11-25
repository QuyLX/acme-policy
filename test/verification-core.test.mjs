// Unit tests of tech-design 13 group A: flaky policy (SC-06), oracle change + trace (SC-19), profile resolution (SC-21).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readYaml, policyPath } from '../lib/io.mjs';
import { validate } from '../lib/schema.mjs';
import { checkDef } from '../lib/registry.mjs';
import { deriveTask, classifyPlaybookChange } from '../lib/task-runner.mjs';
import { loadPlaybook, readEvents } from '../checks/workflow/conformance.mjs';
import { classifyRerun, classifyStress, flakyPolicyCheck, loadFlakyRegistry, registeredFlakeFailure, stressRun } from '../lib/flaky.mjs';
import { runOracle } from '../lib/incident-regression.mjs';
import { testCasesFrom, trace } from '../lib/trace.mjs';
import { blockingIncomparableAt, loadLayer, profileResolveCheck, resolutionEvidence, resolveProfiles } from '../lib/resolve.mjs';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TID = 'src/poller.test.mjs::LRO polling keeps the newest operation state';
const registered = () => loadFlakyRegistry(policyPath('showcase/fixtures/flaky/registry-registered.yaml'));
const empty = () => loadFlakyRegistry(policyPath('showcase/fixtures/flaky/registry-empty.yaml'));
const AT = '2026-11-25T10:00:00Z';

// ---- SC-06 ----

test('the central flaky registry is valid and empty', () => {
  const reg = readYaml(policyPath('registry', 'flaky.yaml'));
  assert.deepEqual(validate('flaky-registry', reg), []);
  assert.deepEqual(reg.entries, []);
});

test('classifyRerun: unregistered fail-then-pass is FAIL flaky.new-nondeterminism with both attempts recorded', () => {
  const r = classifyRerun({ testId: TID, attempts: ['FAIL', 'PASS'], registry: empty(), at: AT });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.findings[0].ruleId, 'flaky.new-nondeterminism');
  assert.deepEqual(r.flaky, { registered: false });
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.extensions['x-reruns'], [{ attempt: 1, status: 'FAIL' }, { attempt: 2, status: 'PASS' }]);
});

test('classifyRerun: registered fail-then-pass is PASS with flaky.registered and the quarantine id', () => {
  const r = classifyRerun({ testId: TID, checkId: 'quality.test', attempts: ['FAIL', 'PASS'], registry: registered(), at: AT });
  assert.equal(r.status, 'PASS');
  assert.deepEqual(r.flaky, { registered: true, quarantineId: 'Q-2026-001' });
  assert.equal(r.extensions['x-reruns'].length, 2);
});

test('classifyRerun: a retry ending in ERROR is infrastructure; more than one retry is not allowed', () => {
  const e = classifyRerun({ testId: TID, attempts: ['FAIL', 'ERROR'], registry: registered(), at: AT });
  assert.equal(e.status, 'ERROR');
  assert.equal(e.findings[0].ruleId, 'flaky.infra');
  const many = classifyRerun({ testId: TID, attempts: ['FAIL', 'FAIL', 'PASS'], registry: registered(), at: AT });
  assert.equal(many.status, 'FAIL');
  assert.equal(many.findings[0].ruleId, 'flaky.retry-limit');
});

test('classifyRerun: an expired quarantine, or one not decided by the owner, does not count', () => {
  const expired = classifyRerun({ testId: TID, attempts: ['FAIL', 'PASS'], registry: registered(), at: '2026-12-11T00:00:00Z' });
  assert.equal(expired.status, 'FAIL');
  const reg = registered();
  reg.entries[0].decidedBy = 'user:someone-else';
  const notOwner = classifyRerun({ testId: TID, attempts: ['FAIL', 'PASS'], registry: reg, at: AT });
  assert.equal(notOwner.findings[0].ruleId, 'flaky.new-nondeterminism');
});

test('stressRun really reproduces the LRO race in 5 iterations; classifyStress FAILs', () => {
  const results = stressRun({ cwd: policyPath('showcase/fixtures/lro-polling'), file: 'src/poller.test.mjs', n: 5 });
  assert.deepEqual(results.map((r) => r.status), ['PASS', 'PASS', 'PASS', 'FAIL', 'PASS']);
  const v = classifyStress({ testId: TID, results });
  assert.equal(v.status, 'FAIL');
  assert.equal(v.findings[0].ruleId, 'flaky.stress-reproduced');
  assert.equal(classifyStress({ testId: TID, results: results.map((r) => ({ ...r, status: 'PASS' })) }).status, 'PASS');
});

test('quality.flaky-policy: an agent-added quarantine fails; the owner-added one passes; observe never FAILs', () => {
  const def = checkDef('quality.flaky-policy');
  const agent = flakyPolicyCheck(def, readYaml(policyPath('showcase/fixtures/flaky/policy-agent-quarantines.yaml')));
  assert.equal(agent.status, 'FAIL');
  assert.ok(agent.findings.every((f) => f.ruleId === 'flaky.quarantine-owner'));
  const owner = flakyPolicyCheck(def, readYaml(policyPath('showcase/fixtures/flaky/policy-owner-quarantines.yaml')));
  assert.equal(owner.status, 'PASS');
  // an owner-decided entry added by an agent identity is still the agent quarantining (Standard §7.14 item 4)
  const input = readYaml(policyPath('showcase/fixtures/flaky/policy-owner-quarantines.yaml'));
  input.change.actor = { id: 'agent:implementer-1', kind: 'agent' };
  assert.equal(flakyPolicyCheck(def, input).status, 'FAIL');
  const observe = flakyPolicyCheck({ ...def, enforcement: 'observe' }, readYaml(policyPath('showcase/fixtures/flaky/policy-agent-quarantines.yaml')));
  assert.equal(observe.status, 'PASS');
  assert.ok(observe.findings.every((f) => f.severity === 'INFO'));
});

test('task runner: a verify FAIL on registered flakes only does not consume the verify budget', () => {
  const events = readEvents(policyPath('showcase/fixtures/flaky/registered-flake-task.jsonl'));
  const pb = loadPlaybook('bug-fix@1.0.0');
  const ok = deriveTask(events, pb, { policyCost: 20, flakyRegistry: registered() });
  assert.equal(ok.task.state, 'MERGED');
  assert.equal(ok.task.verifyFails, 0);
  assert.deepEqual(ok.violations, []);
  assert.ok(ok.recoveries.some((r) => r.cause === 'registered-flake'));
  const none = deriveTask(events, pb, { policyCost: 20, flakyRegistry: empty() });
  assert.equal(none.task.state, 'ESCALATED');
  assert.equal(none.task.verifyFails, 4);
  // one unregistered failing test among the flakes: the FAIL counts
  const mixed = events.map((e) => (e.data.status === 'FAIL' ? { ...e, data: { ...e.data, failedTests: [TID, 'src/other.test.mjs::real failure'] } } : e));
  assert.equal(deriveTask(mixed, pb, { policyCost: 20, flakyRegistry: registered() }).task.verifyFails, 4);
  assert.equal(registeredFlakeFailure({ at: AT, data: { status: 'FAIL' } }, registered()), null);
});

// ---- SC-19 ----

const sc19 = (name) => readEvents(policyPath(`showcase/fixtures/console-compute/events/${name}.jsonl`));
const rfi = () => loadPlaybook('regression-from-incident@1');

test('regression-from-incident is a valid PROPOSED playbook that keeps every gate of bug-fix and adds scenario-approval', () => {
  const pb = rfi();
  assert.deepEqual(validate('task-workflow-spec', pb), []);
  assert.equal(pb.metadata.status, 'PROPOSED');
  assert.deepEqual(classifyPlaybookChange(loadPlaybook('bug-fix@1'), pb).filter((c) => c.direction === 'loosen'), []);
  assert.equal(pb.spec.checkpoints.find((c) => c.id === 'scenario-approval')?.kind, 'mandatory');
  assert.deepEqual(pb.spec.subStates, { CONTEXT_READY: ['REPRODUCING', 'REPRODUCED'], PLANNED: ['SCENARIO_APPROVED'], EXECUTING: ['FIXING'] });
});

test('oracle change request returns the task to PLANNED; only the AC approver decides', () => {
  const req = deriveTask(sc19('oracle-change-request'), rfi());
  assert.equal(req.task.state, 'PLANNED');
  assert.deepEqual(req.violations, []);
  assert.equal(req.transitions.at(-1).reason, 'oracle change requested (FE §9.10 item 3)');
  const byRequester = deriveTask(sc19('oracle-change-decided-by-requester'), rfi());
  assert.ok(byRequester.violations.some((v) => v.code === 'WF-ORACLE-CHANGE' && /requester/.test(v.message)));
  const byImplementer = deriveTask(sc19('oracle-change-decided-by-implementer'), rfi());
  assert.ok(byImplementer.violations.some((v) => /implementer/.test(v.message)));
  assert.deepEqual(deriveTask(sc19('oracle-change-decided-by-ac-approver'), rfi()).violations, []);
});

test('oracle change: the requester may decide below Medium only if an AC approver; an undecided request blocks the gate', () => {
  const events = sc19('oracle-change-decided-by-requester').map((e) => {
    if (e.type === 'facts.recorded') return { ...e, data: { ...e.data, tier: 'Low' } };
    if (e.type === 'checkpoint.recorded' && e.data.checkpoint === 'requirement-review') return { ...e, data: { ...e.data, approvals: [{ by: 'user:requester-a' }] } };
    return e;
  });
  assert.deepEqual(deriveTask(events, rfi()).violations, []);
  const happy = readEvents(policyPath('checks/workflow/fixtures/happy.jsonl'));
  const gate = happy.findIndex((e) => e.type === 'step.completed' && e.data.step === 'approve-merge');
  const at = happy[gate - 1].at;
  const withRequest = [...happy.slice(0, gate), { ...happy[gate - 1], at, actor: { id: 'agent:implementer-1', kind: 'agent' }, type: 'oracle.change-requested', data: { files: ['a.oracle.test.ts'] } }, ...happy.slice(gate)];
  const d = deriveTask(withRequest, loadPlaybook(happy[0].data.workflow), { policyCost: 20 });
  assert.ok(d.violations.some((v) => v.code === 'WF-ORACLE-CHANGE' && /undecided/.test(v.message)));
});

test('the reproduction oracle fails on the faulty fixture commit for AC-CI-6 only', () => {
  const r = runOracle(policyPath('showcase/fixtures/console-compute'), 'src/lro.oracle.test.mjs');
  assert.notEqual(r.exitCode, 0);
  assert.deepEqual(r.results.map((x) => [/@ac:(\S+)/.exec(x.title)[1], x.status]), [['AC-CI-1', 'PASS'], ['AC-CI-6', 'FAIL']]);
});

test('trace: tags are parsed; gaps are reported; a complete chain needs PASS evidence for every AC', () => {
  const testFiles = [{ path: 'a.test.mjs', content: "test('@journey:j1 @scenario:s1 @ac:AC-1 one', () => {});\nit(\"@ac:AC-9 dangling\", () => {});\ntest('untagged', () => {});" }];
  const cases = testCasesFrom(testFiles);
  assert.deepEqual(cases.map((c) => [c.journeys, c.scenarios, c.ac]), [[['j1'], ['s1'], ['AC-1']], [[], [], ['AC-9']]]);
  const journeys = [{ id: 'j1', requirements: ['req:K-1'], scenarios: [{ id: 's1', ac: ['AC-1'] }, { id: 's2', ac: ['AC-2'] }] }];
  const run = (status) => ({ runId: 'r1', subject: { commitSha: 'abc' }, provenance: { finishedAt: '2026-11-25T00:00:00Z' }, checks: [{ checkId: 'quality.test', extensions: { 'x-test-cases': [{ id: 'a.test.mjs::@journey:j1 @scenario:s1 @ac:AC-1 one', status }] } }] });
  const gaps = trace('req:K-1', { journeys, testFiles, runs: [run('PASS')] });
  const rules = gaps.findings.map((f) => f.ruleId);
  assert.ok(rules.includes('trace.ac-without-test'));
  assert.ok(rules.includes('trace.dangling-tag'));
  assert.equal(gaps.complete, false);
  const one = trace('AC-1', { journeys, testFiles, runs: [run('PASS')] });
  assert.equal(one.complete, true);
  assert.ok(one.findings.some((f) => f.ruleId === 'trace.complete'));
  assert.equal(trace('AC-1', { journeys, testFiles, runs: [run('FAIL')] }).findings.some((f) => f.ruleId === 'trace.no-pass-evidence'), true);
  assert.ok(trace('req:NONE', { journeys, testFiles, runs: [] }).findings.some((f) => f.ruleId === 'trace.unknown-ref'));
});

// ---- SC-21 ----

const L = (n) => loadLayer(`showcase/fixtures/profile-layers/${n}.yaml`);

test('resolveProfiles: stricter, union and rejected loosening are recorded in the trace', () => {
  const r = resolveProfiles([L('core'), L('domain'), L('task-loosens')], { blockingIncomparable: true });
  assert.equal(r.ok, true);
  assert.equal(r.plan['integrity.oracle-lock'].requirement, 'required');
  assert.deepEqual(r.plan['quality.test'].params.coverage, { min: 80 });
  const by = (id, p) => r.resolution.conflicts.filter((c) => c.checkId === id && c.parameter === p).map((c) => c.resolvedBy);
  assert.deepEqual(by('quality.test', 'coverage'), ['stricter', 'rejected']);
  assert.deepEqual(by('integrity.oracle-lock', 'requirement'), ['rejected']);
  const u = resolveProfiles([L('core'), L('domain'), L('repository-node26-decided')], { blockingIncomparable: true });
  assert.deepEqual(u.plan['test.e2e-journeys'].params.browsers, { set: ['chromium', 'webkit'] });
  assert.equal(u.plan['test.e2e-journeys'].requirement, 'required');
  assert.deepEqual(u.resolution.layers.map((l) => l.layer), ['core', 'domain', 'repository']);
});

test('resolveProfiles: incomparable runtime pins block, are provisional before blocking, or follow a recorded decision', () => {
  const layers = [L('core'), L('domain'), L('repository-node26')];
  const blocked = resolveProfiles(layers, { blockingIncomparable: true });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.plan['meta.toolchain-pin'].params.node, { exact: '24' }); // never silently changed
  const interim = resolveProfiles(layers, { now: '2026-11-25' });
  assert.equal(interim.ok, true);
  assert.deepEqual(interim.plan['meta.toolchain-pin'].params.node, { exact: '26' });
  assert.equal(interim.resolution.conflicts.find((c) => c.parameter === 'node')['x-fe'].state, 'provisional');
  assert.equal(resolveProfiles(layers, { now: '2027-04-01' }).blocked, true);
  const decided = resolveProfiles([L('core'), L('domain'), L('repository-node26-decided')], { blockingIncomparable: true });
  assert.equal(decided.ok, true);
  assert.equal(decided.resolution.conflicts.find((c) => c.parameter === 'node').decisionRef, 'console-repo@2.3.1#resolution-1');
});

test('resolveProfiles: a decision without both owners, or in a more general layer, does not resolve; order is enforced', () => {
  const repo = L('repository-node26-decided');
  repo.resolutions = [{ ...repo.resolutions[0], decidedBy: ['team-console'] }];
  const r = resolveProfiles([L('core'), L('domain'), repo], { blockingIncomparable: true });
  assert.equal(r.blocked, true);
  assert.ok(r.findings.some((f) => f.ruleId === 'profile.decision-incomplete'));
  const domain = { ...L('domain'), resolutions: L('repository-node26-decided').resolutions };
  assert.equal(resolveProfiles([L('core'), domain, L('repository-node26')], { blockingIncomparable: true }).blocked, true);
  assert.throws(() => resolveProfiles([L('domain'), L('core')]), /out of order/);
});

test('resolveProfiles: planned checks are dropped and shadow checks run at observe (Standard §7.3 item 7)', () => {
  const registry = [{ checkId: 'quality.test', lifecycle: 'shadow' }, { checkId: 'integrity.oracle-lock', lifecycle: 'planned' }];
  const r = resolveProfiles([L('core')], { registry });
  assert.equal(r.plan['integrity.oracle-lock'], undefined);
  assert.equal(r.plan['quality.test'].enforcement, 'observe');
});

const PL = (n) => readYaml(policyPath(`showcase/fixtures/profile-layers/${n}.yaml`));

test('profile.resolve: warn before the switch date, blocking after; the trace is in the evidence', () => {
  const def = checkDef('profile.resolve');
  assert.equal(blockingIncomparableAt('2027-03-31'), false);
  assert.equal(blockingIncomparableAt('2027-04-01'), true);
  assert.equal(blockingIncomparableAt('2026-12-01', '2027-04-01', '2026-12-01'), true); // Phase 2 started first
  assert.equal(blockingIncomparableAt('2026-11-30', '2027-04-01', '2026-12-01'), false);
  const interim = profileResolveCheck(def, PL('conflict'), { now: '2026-11-25T00:00:00Z' }).result;
  assert.equal(interim.status, 'PASS');
  assert.equal(interim.enforcement, 'warn');
  const blocking = profileResolveCheck(def, PL('conflict'), { now: '2027-04-01T00:00:00Z' }).result;
  assert.equal(blocking.status, 'FAIL');
  assert.equal(blocking.enforcement, 'blocking');
  assert.equal(blocking.extensions['x-resolution'].conflicts.find((c) => c.parameter === 'node')['x-fe'].state, 'blocked');
  // The policy, not the request, enables blocking early: a registry entry recording Phase 2 blocks before the date.
  const phase2 = { ...def, params: { ...def.params, phase2Since: '2026-11-01' } };
  assert.equal(profileResolveCheck(phase2, PL('conflict'), { now: '2026-11-25T00:00:00Z' }).result.status, 'FAIL');
});

test('profile.resolve: a request claiming blockingIncomparable false and an old date still blocks after the switch date', () => {
  const def = checkDef('profile.resolve');
  const lying = PL('conflict-claims-nonblocking');
  assert.equal(lying.blockingIncomparable, false);
  const r = profileResolveCheck(def, lying, { now: '2027-04-01T00:00:00Z' }).result;
  assert.equal(r.status, 'FAIL');
  assert.equal(r.enforcement, 'blocking');
  assert.equal(r.extensions['x-blocking-incomparable'], true);
  assert.ok(r.findings.some((f) => f.ruleId === 'profile.conflict-incomparable' && f.severity === 'BLOCKER'));
  assert.ok(r.findings.some((f) => f.ruleId === 'profile.request-switch-ignored'));
  // The opposite lie (blocking on, a future date) does not turn blocking on before the switch either.
  const early = profileResolveCheck(def, { ...PL('conflict'), blockingIncomparable: true, at: '2030-01-01' }, { now: '2026-11-25T00:00:00Z' }).result;
  assert.equal(early.status, 'PASS');
  assert.equal(early.extensions['x-blocking-incomparable'], false);
  // A recorded decision resolves the conflict whatever the clock.
  assert.equal(profileResolveCheck(def, PL('conflict-decided'), { now: '2027-04-01T00:00:00Z' }).result.status, 'PASS');
});

test('acme-policy run puts the profile.resolve trace into the VerificationRun (resolution, resolvedProfiles)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acme-resolve-run-'));
  try {
    cpSync(policyPath('showcase/fixtures/profile-layers'), dir, { recursive: true });
    const G = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];
    for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'base']]) assert.equal(spawnSync('git', [...G, ...args], { cwd: dir }).status, 0);
    const r = spawnSync(process.execPath, [policyPath('bin', 'acme-policy.mjs'), 'run', '--repo', dir, '--checks', 'profile.resolve', '--input', policyPath('showcase/fixtures/profile-layers/conflict-decided.yaml')], { encoding: 'utf8', env: { ...process.env, FACTORY_EXECUTOR: 'ci' } });
    const run = JSON.parse(r.stdout);
    assert.deepEqual(validate('verification-run', run), []);
    assert.deepEqual(run.resolution, run.checks[0].extensions['x-resolution']);
    assert.deepEqual(run.resolvedProfiles.map((p) => p.id), ['aisf-core', 'aisf-frontend', 'console-repo']);
    assert.equal(run.resolution.conflicts.find((c) => c.parameter === 'node').decisionRef, 'console-repo@2.3.1#resolution-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(resolutionEvidence([{ checkId: 'quality.lint', status: 'PASS' }]), {});
});

test('task runner: a blocked profile resolution moves the task to BLOCKED', () => {
  const events = readEvents(policyPath('showcase/fixtures/profile-layers/task-context-ready.jsonl'));
  const blocked = [...events, { ...events.at(-1), at: '2026-11-25T09:10:00Z', actor: { id: 'ci:resolver', kind: 'ci' }, type: 'profile.resolved', data: { blocked: true, conflicts: [{ checkId: 'meta.toolchain-pin', parameter: 'node', values: ['24', '26'], resolvedBy: 'rejected' }] } }];
  const d = deriveTask(blocked, loadPlaybook('bug-fix@1'));
  assert.equal(d.task.state, 'BLOCKED');
  assert.match(d.transitions.at(-1).reason, /meta\.toolchain-pin\.node/);
  const ok = [...events, { ...blocked.at(-1), data: { blocked: false, conflicts: [] } }];
  assert.equal(deriveTask(ok, loadPlaybook('bug-fix@1')).task.state, 'CONTEXT_READY');
});
