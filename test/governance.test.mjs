// Unit tests of tech-design 13 group C (governance): SC-05 egress, SC-07, SC-12, SC-13, SC-15.
// Also the proof test of admin.step-up-auth (registry/checks.yaml): its consumer result is always NOT_ASSESSED, so the
// conforming side (assessed-elsewhere, exit 0) is proven here rather than by test/registry-proof.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readYaml, readJson, policyPath } from '../lib/io.mjs';
import { checkDef } from '../lib/registry.mjs';
import { validate } from '../lib/schema.mjs';
import { runExitCode, assessedElsewhere } from '../lib/result.mjs';
import { readInput, targetDef } from '../lib/governance-result.mjs';
import { resolveBackend, sbplProfile, dockerArgs, scrubEnv, egressProbe, listenerHost, observableHostFile, MUTATIONS } from '../lib/sandbox-runner.mjs';
import { classifyProbe, sandboxEgressCheck } from '../checks/sec/sandbox-egress.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { attribute } from '../lib/merge-queue.mjs';
import { deriveTask } from '../lib/task-runner.mjs';
import { readEvents, loadPlaybook } from '../checks/workflow/conformance.mjs';
import { canonicalJson, evaluateAssessedElsewhere, relevantDeployment } from '../lib/assessed-elsewhere.mjs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { crossTeamContractCheck } from '../checks/contract/cross-team.mjs';
import { precision, promoteMode, scoreReviewerChange, scoreOnEvalSet } from '../lib/review-quality.mjs';
import { upperBound, evaluateTrust } from '../lib/trust.mjs';
import { trustEvaluationCheck, trustRequest } from '../checks/trust/evaluation.mjs';
import { decideAutonomy, matrix } from '../lib/autonomy.mjs';
import { applySignals, loosen, trippedFor } from '../lib/breakers.mjs';
import { evaluateShepherdAction } from '../lib/change-shepherd.mjs';
import { reviewIncident, appendEvalCase } from '../lib/incident.mjs';
import { KINDS } from '../lib/modules/governance.mjs';
import { autonomyCheck, breakerStateFor, registryPilotMode } from '../checks/ops/governance-ops.mjs';
import { aiModeCheck, currentModeFromDescriptor } from '../checks/review/quality.mjs';
import { sodCheck } from '../checks/policy-sod/evaluate.mjs';

const fx = (p) => readInput(policyPath(p));
const sandboxPolicy = readYaml(policyPath('agents', 'sandbox.yaml'));

// ---------------------------------------------------------------- SC-05 sandbox egress
test('sandbox: FACTORY_SANDBOX_BACKEND=none forces the no-backend path; a required missing backend throws', () => {
  assert.equal(resolveBackend({ required: 'none' }), null);
  assert.throws(() => resolveBackend({ platform: 'win32', required: 'docker' }), /docker required/);
  assert.equal(resolveBackend({ platform: 'win32', required: null }), null);
});
test('sandbox: env is scrubbed to the allowlist (no host canary, no tokens)', () => {
  assert.deepEqual(scrubEnv({ FACTORY_EGRESS_CANARY: 'x', HOME: '/h', LANG: 'C', GH_TOKEN: 't' }), { LANG: 'C' });
});
test('sandbox: SBPL denies network, exec except node, writes and reads outside the worktree', () => {
  const p = sbplProfile({ worktree: '/tmp', node: process.execPath, policy: sandboxPolicy });
  for (const s of ['(deny network*)', '(deny process-exec*)', '(deny file-write*)', '(deny file-read*)']) assert.ok(p.includes(s), s);
  const mutated = sbplProfile({ worktree: '/tmp', node: process.execPath, policy: MUTATIONS['network-allowed'](sandboxPolicy) });
  assert.ok(!mutated.includes('(deny network*)') && mutated.includes('(deny file-read*)'), 'the mutation removes only the network restriction');
});
test('sandbox: docker runs with no network, no capabilities, read-only root and an explicit env only', () => {
  const a = dockerArgs({ worktree: '/tmp', cmd: ['node', 'step.mjs'], env: { LANG: 'C' }, policy: sandboxPolicy, uid: 1000, gid: 1000 });
  const s = a.join(' ');
  for (const x of ['--network none', '--cap-drop ALL', '--read-only', 'no-new-privileges', '-e LANG=C', '--user 1000:1000']) assert.ok(s.includes(x), x);
  assert.ok(!s.includes('CANARY'));
  const m = dockerArgs({ worktree: '/tmp', cmd: ['node', 'step.mjs'], env: {}, policy: MUTATIONS['network-allowed'](sandboxPolicy), uid: 1000, gid: 1000 }).join(' ');
  assert.ok(m.includes('--network bridge') && m.includes('--cap-drop ALL'), 'the docker mutation is the same container on the bridge network');
});
test('sandbox: on docker an undeterminable bridge gateway is an error, never a loopback fallback', () => {
  assert.equal(listenerHost('sandbox-exec'), '127.0.0.1');
  assert.equal(listenerHost('docker', () => ({ status: 0, stdout: '172.17.0.1\n' })), '172.17.0.1');
  assert.throws(() => listenerHost('docker', () => ({ status: 1, stdout: '', stderr: 'no such network' })), /bridge gateway not found/);
  assert.throws(() => listenerHost('docker', () => ({ status: 0, stdout: '<no value>' })), /bridge gateway not found/);
});
test('sec.sandbox-egress: a probe infrastructure error is ERROR; a step that did not run is ERROR, never PASS', () => {
  const def = targetDef('sec.sandbox-egress');
  const spec = fx('checks/sec/fixtures/egress-sandboxed.yaml');
  assert.equal(sandboxEgressCheck(def, spec, { probe: () => ({ assessed: true, infraError: 'bind EADDRNOTAVAIL', backend: 'docker' }) }).status, 'ERROR');
  const quiet = { assessed: true, backend: 'docker', exitCode: 0, stepRan: false, requestsReceived: 0, stepReport: { ran: true } };
  assert.equal(sandboxEgressCheck(def, spec, { probe: () => quiet }).status, 'ERROR', 'a self-reported "ran" does not count');
  // The step's self-report never decides: claiming it read the host file or saw the canary changes nothing.
  const clean = { ...quiet, stepRan: true, stepReport: { hostFileRead: 'ok', sawEnvCanary: true } };
  assert.equal(sandboxEgressCheck(def, spec, { probe: () => clean }).status, 'PASS');
});
test('sandbox: the FIFO host file reports an open by another process, and only then', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acme-fifo-'));
  try {
    const untouched = observableHostFile(join(dir, 'a'), 'x');
    await new Promise((r) => setTimeout(r, 50));
    await untouched.close();
    assert.equal(untouched.opened(), false);
    const read = observableHostFile(join(dir, 'b'), 'canary-test\n');
    const child = spawn(process.execPath, ['-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(dir, 'b'))}, 'utf8'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    await new Promise((r) => child.on('close', r));
    assert.equal(read.opened(), true);
    assert.equal(out, 'canary-test\n');
    await read.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('sandbox: "the step ran" is observed by the host (exit 0 + work product), not taken from the step report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'acme-liar-'));
  try {
    const liar = join(dir, 'liar-step.mjs');
    writeFileSync(liar, "console.log(JSON.stringify({ ran: true, hostFileRead: 'EPERM', post: 'EPERM' }));\n");
    const r = await egressProbe({ issue: policyPath('showcase/fixtures/exfil/issue.md'), step: liar, sandbox: 'none' });
    assert.equal(r.stepReport.ran, true);
    assert.equal(r.stepRan, false, 'no work product in the worktree');
    assert.equal(r.requestsReceived, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('sandbox: no backend → not assessed (never a simulated PASS)', async () => {
  const r = await egressProbe({ issue: policyPath('showcase/fixtures/exfil/issue.md'), step: policyPath('showcase/fixtures/exfil/compromised-step.mjs'), sandbox: 'auto', backend: null });
  assert.equal(r.assessed, false);
});
test('sandbox: classifyProbe treats any request, canary or out-of-worktree access observed by the host as a leak', () => {
  const clean = { requestsReceived: 0 };
  assert.deepEqual(classifyProbe(clean).leaks, []);
  assert.equal(classifyProbe({ ...clean, canaryInEnvGiven: true }).leaks.length, 1);
  assert.equal(classifyProbe({ ...clean, hostFileOpened: true }).leaks.length, 1);
  assert.equal(classifyProbe({ ...clean, wroteOutsideWorktree: true }).leaks.length, 1);
  assert.deepEqual(classifyProbe({ ...clean, stepReport: { hostFileRead: 'ok', sawEnvCanary: true } }).leaks, [], 'self-reports are not observations');
});
const backend = (() => { try { return resolveBackend(); } catch { return null; } })();
const exfil = { issue: policyPath('showcase/fixtures/exfil/issue.md'), step: policyPath('showcase/fixtures/exfil/compromised-step.mjs') };
test('sandbox: the compromised step is contained by the host backend', { skip: !backend && 'no sandbox backend on this host' }, async () => {
  const r = await egressProbe({ ...exfil, sandbox: 'auto' });
  assert.equal(r.stepRan, true);
  assert.equal(r.requestsReceived, 0);
  assert.equal(r.canaryInEnvGiven, false);
  assert.equal(r.hostFileOpened, false);
  assert.equal(r.wroteOutsideWorktree, false);
});
test('sandbox: the same backend with the network allowed leaks (mutation proof)', { skip: !backend && 'no sandbox backend on this host' }, async () => {
  const r = await egressProbe({ ...exfil, sandbox: 'auto', mutation: 'network-allowed' });
  assert.equal(r.backend, backend);
  assert.equal(r.stepRan, true);
  assert.equal(r.requestsReceived, 1);
  assert.equal(r.hostFileOpened, false, 'file reads stay confined');
});

// ---------------------------------------------------------------- SC-07 merge queue
test('queue: Standard §6.4 item 19 table; ERROR never consumes budget', () => {
  assert.equal(attribute({ a: 'FAIL' }).attribution, 'main-broken');
  assert.equal(attribute({ a: 'FAIL' }).consumesBudget, false);
  assert.equal(attribute({ a: 'FAIL' }).pauseQueue, true);
  assert.equal(attribute({ a: 'PASS', b: 'FAIL' }).consumesBudget, true);
  assert.equal(attribute({ a: 'PASS', b: 'PASS' }).attribution, 'flake-candidate');
  assert.equal(attribute({ a: 'PASS', b: 'ERROR' }).consumesBudget, false);
  assert.equal(attribute({ a: 'ERROR' }).attribution, 'error');
});
const qEvents = (results, budgets) => {
  const base = readEvents(policyPath('showcase/fixtures/queue/task-approved.jsonl'));
  if (budgets) base[0] = { ...base[0], data: { ...base[0].data, budgets } };
  return [...base, ...results.flatMap((attribution, i) => [
    { workItemId: 'TASK-Q1', at: `2026-11-24T1${i + 1}:00:00Z`, actor: { id: 'ci:merge-queue', kind: 'ci' }, type: 'queue.entered', data: {} },
    { workItemId: 'TASK-Q1', at: `2026-11-24T1${i + 1}:00:01Z`, actor: { id: 'ci:merge-queue', kind: 'ci' }, type: 'queue.result', data: { attribution, checkId: 'quality.typecheck' } },
  ])];
};
const derive = (events) => deriveTask(events, loadPlaybook('bug-fix@1.0.0'));
test('queue events: attributed → REPAIRING and 1 attempt used; main-broken and flake consume nothing', () => {
  assert.equal(derive(qEvents(['attributed-to-change'])).task.state, 'REPAIRING');
  assert.deepEqual(derive(qEvents(['attributed-to-change'])).task.mergeQueueAttempts, { limit: 2, used: 1 });
  const d = derive(qEvents(['main-broken', 'flake-candidate', 'error']));
  assert.equal(d.task.state, 'IN_MERGE_QUEUE');
  assert.equal(d.task.mergeQueueAttempts.used, 0);
  assert.equal(d.task.queuePaused, true);
});
test('queue events: effective budget = min(policy, playbook, task); a task cannot raise it', () => {
  assert.equal(derive(qEvents(['attributed-to-change'], { mergeQueueAttempts: 1 })).task.state, 'ESCALATED');
  const raised = derive(qEvents(['attributed-to-change', 'attributed-to-change'], { mergeQueueAttempts: 5 }));
  assert.deepEqual(raised.task.mergeQueueAttempts, { limit: 2, used: 2 });
  assert.equal(raised.task.state, 'ESCALATED');
  assert.ok(raised.violations.some((v) => v.code === 'WF-LOOP'));
});
test('queue events: unknown attribution is a violation, not a silent pass', () => {
  assert.ok(derive(qEvents(['looks-fine'])).violations.some((v) => v.code === 'WF-QUEUE'));
});

// ---------------------------------------------------------------- SC-12 cross-team contract
const registeredProvider = checkDef('admin.step-up-auth').params.provider;
const contract = (bundlePath, patch = {}) => {
  const b = fx(bundlePath);
  return { checkId: 'admin.step-up-auth', providerRun: fx(b.providerRun), attestation: b.providerAttestation && fx(b.providerAttestation), deployments: fx(b.deployments), environment: b.environment, now: b.now, freshnessDays: 7, provider: registeredProvider, ...patch };
};
test('assessed-elsewhere: attested run for the deployed version within 7 days → valid disposition (K.2)', () => {
  const v = evaluateAssessedElsewhere(contract('showcase/fixtures/contract/verified.yaml'));
  assert.equal(v.valid, true);
  assert.equal(v.disposition.decidedBy, 'policy');
  assert.equal(v.disposition.assessedElsewhere.validUntil, '2026-11-24T09:00:00.000Z');
});
test('assessed-elsewhere: unverified deploy, stale run, unattested run, provider FAIL, pending deploy all refuse', () => {
  const rules = (args) => evaluateAssessedElsewhere(args).problems.map((p) => p.ruleId);
  assert.deepEqual(rules(contract('showcase/fixtures/contract/unverified-deploy.yaml')), ['contract.version-mismatch']);
  assert.deepEqual(rules(contract('showcase/fixtures/contract/stale.yaml')), ['contract.stale']);
  assert.ok(rules(contract('showcase/fixtures/contract/verified.yaml', { provider: { ...registeredProvider, pinnedPolicySha: 'f'.repeat(40) } })).includes('contract.not-attested'));
  const run = fx('showcase/fixtures/contract/provider-run-v1.json');
  const failing = { ...run, checks: [{ ...run.checks[0], status: 'FAIL', reason: 'step-up not required' }] };
  assert.ok(rules(contract('showcase/fixtures/contract/verified.yaml', { providerRun: failing })).includes('contract.provider-not-pass'));
  assert.ok(rules(contract('showcase/fixtures/contract/verified.yaml', { provider: { ...registeredProvider, id: 'other-provider' } })).includes('contract.no-deployment'), 'deployment records of another provider do not count');
  const deps = fx('showcase/fixtures/contract/deployments-v1.yaml');
  const pending = [...deps, { ...deps[0], version: '1.6.0', commitSha: '3'.repeat(40), status: 'pending', at: '2026-11-20T08:00:00Z' }];
  assert.equal(relevantDeployment(pending, 'production', Date.parse('2026-11-20T12:00:00Z')).version, '1.6.0');
  assert.ok(rules(contract('showcase/fixtures/contract/verified.yaml', { deployments: pending })).includes('contract.version-mismatch'));
});
test('assessed-elsewhere: the run subject is compared with the deployment record, and the signature binds the run', () => {
  const rules = (args) => evaluateAssessedElsewhere(args).problems.map((p) => p.ruleId);
  // An edited run claiming the deployed v1.5.0 commit: subject = deployment commit, verifierRef pinned, but v1's
  // signature no longer verifies.
  assert.deepEqual(rules(contract('showcase/fixtures/contract/forged-run.yaml')), ['contract.not-attested']);
  assert.match(evaluateAssessedElsewhere(contract('showcase/fixtures/contract/forged-run.yaml')).problems[0].message, /signature does not verify/);
  // Without any signature the run is not attested; a signature by another key neither.
  assert.ok(rules(contract('showcase/fixtures/contract/verified.yaml', { attestation: undefined })).includes('contract.not-attested'));
  const other = generateKeyPairSync('ed25519');
  const run = fx('showcase/fixtures/contract/provider-run-v1.json');
  const otherSig = { keyId: registeredProvider.attestationKey.keyId, alg: 'ed25519', signature: sign(null, Buffer.from(canonicalJson(run)), other.privateKey).toString('base64') };
  assert.ok(rules(contract('showcase/fixtures/contract/verified.yaml', { attestation: otherSig })).includes('contract.not-attested'));
  // A validly signed run (test key) whose subject differs from the deployment record → version-mismatch: the subject is
  // compared with the deployment, not with itself.
  const provider = { ...registeredProvider, attestationKey: { keyId: 'test', alg: 'ed25519', publicKey: other.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } };
  const signed = (r) => ({ providerRun: r, attestation: { keyId: 'test', alg: 'ed25519', signature: sign(null, Buffer.from(canonicalJson(r)), other.privateKey).toString('base64') }, provider });
  assert.deepEqual(rules(contract('showcase/fixtures/contract/verified.yaml', signed(run))), []);
  const elsewhere = { ...run, subject: { ...run.subject, commitSha: '4'.repeat(40) } };
  assert.deepEqual(rules(contract('showcase/fixtures/contract/verified.yaml', signed(elsewhere))), ['contract.version-mismatch']);
  // A signed run whose verifierRef is not the registry's pinned SHA is not attested, whatever the bundle says.
  const forgedRef = { ...run, provenance: { ...run.provenance, verifierRef: 'acme-policy@ffffffffffff' } };
  assert.deepEqual(rules(contract('showcase/fixtures/contract/verified.yaml', signed(forgedRef))), ['contract.not-attested']);
  const def = checkDef('admin.step-up-auth');
  const bundle = { ...fx('showcase/fixtures/contract/verified.yaml'), pinnedPolicySha: 'f'.repeat(40) };
  assert.equal(crossTeamContractCheck(def, bundle).disposition?.type, 'assessed-elsewhere', 'a bundle pinnedPolicySha is ignored');
});
test('admin.step-up-auth proof: NOT_ASSESSED + assessed-elsewhere does not block (exit 0); without it, it blocks (exit 1)', () => {
  const def = checkDef('admin.step-up-auth');
  const ok = crossTeamContractCheck(def, fx('showcase/fixtures/contract/verified.yaml'));
  assert.equal(ok.status, 'NOT_ASSESSED');
  assert.deepEqual(validate('check-result', ok), []);
  assert.equal(runExitCode([ok], { now: Date.parse('2026-11-20T12:00:00Z') }), 0);
  assert.equal(runExitCode([ok], { now: Date.parse('2026-11-24T09:00:01Z') }), 1, 'past validUntil it blocks again');
  for (const bad of ['unverified-deploy', 'stale', 'forged-run']) {
    const r = crossTeamContractCheck(def, fx(`showcase/fixtures/contract/${bad}.yaml`));
    assert.equal(r.disposition, undefined);
    assert.equal(runExitCode([r], { now: Date.parse('2026-11-20T12:00:00Z') }), 1);
  }
  assert.equal(runExitCode([crossTeamContractCheck(def, null)]), 1, 'no provider evidence blocks');
});
test('runExitCode: only a valid policy assessed-elsewhere disposition satisfies a required NOT_ASSESSED', () => {
  const c = (disposition, checkId = 'admin.step-up-auth') => ({ checkId, status: 'NOT_ASSESSED', requirement: 'required', enforcement: 'blocking', disposition });
  const ae = { type: 'assessed-elsewhere', decidedBy: 'policy', decidedAt: 'x', policyRef: 'p', assessedElsewhere: { runId: 'r', providerVersion: 'v', validUntil: '2030-01-01T00:00:00Z' } };
  const at = { now: Date.parse('2029-01-01T00:00:00Z') };
  assert.equal(runExitCode([c(ae)], at), 0);
  // The exemption belongs to registry cross-team-contract checks only (looked up by checkId, never claimed by a result).
  assert.equal(checkDef('policy.sod').requirement, 'required');
  assert.equal(runExitCode([c(ae, 'policy.sod')], at), 1, 'a non-contract required check cannot be exempted');
  assert.equal(runExitCode([{ ...c(ae, 'policy.sod'), ownership: 'cross-team-contract' }], at), 1, 'ownership claimed by the result is ignored');
  assert.equal(runExitCode([c(ae, null)], at), 1, 'no checkId → no exemption');
  assert.equal(runExitCode([c(ae, 'unknown.check')], at), 1, 'unregistered check → no exemption');
  const { policyRef, ...noRef } = ae;
  assert.equal(runExitCode([c(noRef)], at), 1, 'a disposition without policyRef does not exempt');
  assert.equal(runExitCode([c({ ...ae, policyRef: ' ' })], at), 1);
  assert.equal(runExitCode([c({ ...ae, decidedBy: 'user:x' })], { now: Date.parse('2029-01-01T00:00:00Z') }), 1);
  assert.equal(runExitCode([c({ ...ae, assessedElsewhere: { ...ae.assessedElsewhere, validUntil: '2028-01-01T00:00:00Z' } })], { now: Date.parse('2029-01-01T00:00:00Z') }), 1);
  assert.equal(runExitCode([c({ type: 'waived', decidedBy: 'user:x', decidedAt: 'x', waiverId: 'w' })]), 1, 'other dispositions are not evaluated here');
  assert.equal(runExitCode([{ ...c(ae), status: 'FAIL' }], { now: Date.parse('2029-01-01T00:00:00Z') }), 1, 'assessed-elsewhere applies to NOT_ASSESSED only');
  assert.equal(assessedElsewhere({ status: 'PASS' }), false);
});
test('check-result schema: disposition follows K.2 (closed set, policy-decided types need policyRef)', () => {
  const base = { checkId: 'a.b', checkVersion: '1', requiredBy: [], requirement: 'required', enforcement: 'blocking', severity: 'BLOCKER', gate: 'merge', status: 'NOT_ASSESSED', reason: 'r', command: 'c', durationMs: 0, attempts: 1, evidence: [] };
  assert.notDeepEqual(validate('check-result', { ...base, disposition: { type: 'trust-me', decidedBy: 'policy', decidedAt: 'x' } }), []);
  assert.notDeepEqual(validate('check-result', { ...base, disposition: { type: 'assessed-elsewhere', decidedBy: 'user:x', decidedAt: 'x', policyRef: 'p', assessedElsewhere: { runId: 'r', providerVersion: 'v', validUntil: 'u' } } }), []);
});

// ---------------------------------------------------------------- SC-13 review quality and trust
test('review: precision counts only fixed; unknown responses are rejected', () => {
  assert.equal(precision([{ authorResponse: 'fixed' }, { authorResponse: 'wrong' }]).value, 0.5);
  assert.throws(() => precision([{ authorResponse: 'ignored' }]), /authorResponse/);
});
test('review: one step at a time; lowering is loosening; equal mode is a no-op', () => {
  const thresholds = readYaml(policyPath('registry', 'ai-review-thresholds.yaml')).promotion;
  const metrics = { dispositions: 1000, precision: 1, cleanPrs: 1000, harmfulRate: 0, incidentCases: 1000, incidentRecall: 1 };
  assert.equal(promoteMode({ current: 'shadow', requested: 'blocking', metrics, thresholds }).problems[0].ruleId, 'review.mode-skip');
  const low = promoteMode({ current: 'blocking', requested: 'advisory', metrics, thresholds });
  assert.equal(low.loosening, true);
  assert.equal(promoteMode({ current: 'advisory', requested: 'advisory', metrics, thresholds }).changed, false);
});
test('review: a reviewer change is kept only if the score improves; equal score is not kept; partial eval set throws', () => {
  const evalSet = fx('showcase/fixtures/review/eval-set.yaml');
  const base = fx('showcase/fixtures/review/reviewer-baseline.yaml');
  const cand = fx('showcase/fixtures/review/reviewer-candidate.yaml');
  assert.equal(scoreReviewerChange({ evalSet, baseline: cand, candidate: base }).kept, true);
  const same = scoreReviewerChange({ evalSet, baseline: base, candidate: { ...base, version: 'reviewer@1.2.1' } });
  assert.equal(same.kept, false);
  assert.equal(same.problems[0].ruleId, 'review.no-improvement');
  assert.throws(() => scoreOnEvalSet(evalSet, { incidents: base.outputs.incidents.slice(1), cleanPrs: base.outputs.cleanPrs }), /full eval set/);
});
test('trust: 95% upper bound is computed (≈ rule of three), 50 clean → ≤ 6%, 30 clean → > 6%', () => {
  assert.ok(Math.abs(upperBound(0, 50) - (1 - 0.05 ** (1 / 50))) < 1e-12);
  assert.ok(upperBound(0, 50) <= 0.06);
  assert.ok(upperBound(0, 30) > 0.06);
  assert.ok(upperBound(1, 100) > upperBound(0, 100));
  assert.ok(Math.abs(upperBound(1, 100) - 0.0466) < 0.001, `exact CP for 1/100 ≈ 4.66%, got ${upperBound(1, 100)}`);
});
const trust = (path, patch = {}) => {
  const { input, thresholds, owners } = trustRequest(fx(path));
  return evaluateTrust({ ...input, ...patch }, thresholds, owners);
};
test('trust: the count threshold applies per difficulty stratum (FE §10.3)', () => {
  const t = trust('showcase/fixtures/trust/request-t1-after-30.yaml');
  const split = t.evaluation; // baseline: one stratum → T1
  assert.equal(split.resultLevel, 'T1');
  const { input, thresholds, owners } = trustRequest(fx('showcase/fixtures/trust/request-t1-after-30.yaml'));
  const tasks = input.tasks.map((x, i) => ({ ...x, stratum: i % 3 === 0 ? 'multi-doc' : 'link-edit' }));
  const two = evaluateTrust({ ...input, tasks, taskClass: { ...input.taskClass, strata: ['link-edit', 'multi-doc'] } }, thresholds, owners);
  assert.equal(two.evaluation.resultLevel, 'T0');
  assert.ok(two.reasons.some((r) => r.ruleId === 'trust.t1-insufficient-tasks'));
});
test('trust: production merges through A0 do not count toward T2 (FE §10.3)', () => {
  const { input, thresholds, owners } = trustRequest(fx('showcase/fixtures/trust/request-t2-after-50.yaml'));
  const tasks = input.tasks.map((t, i) => (t.environment === 'production' && i % 10 === 0 ? { ...t, mergedVia: 'A0' } : t));
  const r = evaluateTrust({ ...input, tasks }, thresholds, owners);
  assert.equal(r.evaluation.resultLevel, 'T1');
  assert.ok(r.counts.a0Excluded > 0);
});
test('trust: incident → T0 + re-evaluation; failed minor-change regression → not kept; raise needs both owners', () => {
  assert.deepEqual([trust('showcase/fixtures/trust/request-t2-after-50.yaml', { incidents: [{ taskClass: 'docs.link-fix', confirmedBy: 'user:docs-owner' }] }).evaluation].map((e) => [e.resultLevel, e.status])[0], ['T0', 'RE-EVALUATION_REQUIRED']);
  assert.equal(trust('showcase/fixtures/trust/request-t2-after-50.yaml', { versionChange: { kind: 'minor', what: 'skill patch', regressionPassed: false } }).evaluation.resultLevel, 'T0');
  assert.equal(trust('showcase/fixtures/trust/request-t2-after-50.yaml', { versionChange: { kind: 'minor', what: 'skill patch', regressionPassed: true } }).evaluation.resultLevel, 'T2');
  const one = trust('showcase/fixtures/trust/request-t2-after-50.yaml', { decidedBy: ['user:docs-owner'] });
  assert.equal(one.evaluation.resultLevel, 'T0', 'registry/trust.yaml level is kept');
  assert.equal(one.raiseApproved, false);
  assert.deepEqual(validate('trust-evaluation', one.evaluation), []);
});
test('trust: the current level comes from registry/trust.yaml; a request claiming T2 cannot skip the two-owner raise', () => {
  assert.equal(readYaml(policyPath('registry', 'trust.yaml')).classes.find((c) => c.taskClass === 'docs.link-fix').level, 'T0');
  const { input } = trustRequest({ ...fx('showcase/fixtures/trust/request-t2-after-50.yaml'), currentLevel: 'T2', decidedBy: [] });
  assert.equal(input.currentLevel, 'T0');
  const r = trustEvaluationCheck(targetDef('trust.evaluation'), { ...fx('showcase/fixtures/trust/request-t2-after-50.yaml'), currentLevel: 'T2', decidedBy: [] });
  assert.equal(r.result.status, 'FAIL');
  assert.equal(r.decision.resultLevel, 'T0');
  assert.ok(r.result.findings.some((f) => f.ruleId === 'trust.raise-needs-owners'));
});
test('trust: tasks older than the 6-month window do not count', () => {
  const r = trust('showcase/fixtures/trust/request-t1-after-30.yaml', { window: { from: '2026-01-01T00:00:00Z', to: '2027-01-20T00:00:00Z' } });
  assert.equal(r.evaluation.resultLevel, 'T0');
  assert.ok(r.reasons.some((x) => x.ruleId === 'trust.window-clipped'));
});

test('trust: the 95% upper bound alone can refuse T2 (count, window, escaped defects and interventions all pass)', () => {
  const t2Rules = (r) => r.reasons.map((x) => x.ruleId).filter((id) => id.startsWith('trust.t2-'));
  // (a) A1 merges the human reviewer had to correct are failures in the bound: 1 of 60 → ≈ 7.7% > 6%.
  const caught = trust('showcase/fixtures/trust/request-t2-human-caught-defect.yaml');
  assert.equal(caught.evaluation.resultLevel, 'T1');
  assert.equal(caught.evaluation.escapedDefects, 0);
  assert.equal(caught.counts.t2Failures, 1);
  assert.deepEqual(t2Rules(caught), ['trust.t2-upper-bound']);
  assert.ok(caught.evaluation.failureRateUpper95 > 0.06 && caught.evaluation.failureRateUpper95 < 0.08);
  // The same record without the correction reaches T2: the bound is what decides.
  const { input, thresholds, owners } = trustRequest(fx('showcase/fixtures/trust/request-t2-human-caught-defect.yaml'));
  const clean = input.tasks.map((t) => (t.id === 'DLF-120' ? { ...t, reviewerChange: 'none' } : t));
  assert.equal(evaluateTrust({ ...input, tasks: clean }, thresholds, owners).evaluation.resultLevel, 'T2');
  // A reverted A1 merge is a failure too (§9.4 item 6).
  const reverted = input.tasks.map((t) => (t.id === 'DLF-120' ? { ...t, reviewerChange: 'none', reverted: true } : t));
  assert.deepEqual(t2Rules(evaluateTrust({ ...input, tasks: reverted }, thresholds, owners)), ['trust.t2-upper-bound']);
  // (b) A profile that raises the evidence (§9.4 item 4) with a stricter bound: 50 clean merges → 5.8% > 3%.
  const strict = { ...thresholds, T2: { ...thresholds.T2, maxUpper95: 0.03 } };
  const fifty = trustRequest(fx('showcase/fixtures/trust/request-t2-after-50.yaml')).input;
  const r = evaluateTrust(fifty, strict, owners);
  assert.equal(r.evaluation.resultLevel, 'T1');
  assert.deepEqual(t2Rules(r), ['trust.t2-upper-bound']);
});
test('trust: the T2 record spans first → last counted merge; stretching the request window.to does not lengthen it', () => {
  const { input, thresholds, owners } = trustRequest(fx('showcase/fixtures/trust/request-t2-after-50.yaml'));
  const prod = input.tasks.filter((t) => t.environment === 'production').map((t) => Date.parse(t.at));
  const first = Math.min(...prod);
  // Compress the production merges to 6.7 weeks; window.to stays 11+ weeks after the first merge.
  const tasks = input.tasks.map((t) => (t.environment === 'production' ? { ...t, at: new Date(first + (Date.parse(t.at) - first) * 0.7).toISOString() } : t));
  const r = evaluateTrust({ ...input, tasks }, thresholds, owners);
  assert.ok((Date.parse(input.window.to) - first) / (7 * 86400000) >= 8, 'the request window alone would satisfy minWeeks');
  assert.ok(r.counts.weeks < 8, `weeks ${r.counts.weeks}`);
  assert.equal(r.evaluation.resultLevel, 'T1');
  assert.ok(r.reasons.some((x) => x.ruleId === 'trust.t2-window'));
  const stretched = evaluateTrust({ ...input, tasks, window: { ...input.window, to: '2026-11-25T00:00:00Z' } }, thresholds, owners);
  assert.equal(stretched.evaluation.resultLevel, 'T1');
  assert.ok(stretched.reasons.some((x) => x.ruleId === 'trust.t2-window'));
});
test('review.ai-mode: the current mode comes from the surface descriptor, never from the request', () => {
  const def = targetDef('review.ai-mode');
  const repo = (m) => policyPath(`showcase/fixtures/review/repo-${m}`);
  assert.deepEqual(currentModeFromDescriptor(repo('shadow'), 'admin/users'), { mode: 'shadow', source: 'apps/admin/factory.yaml' });
  // A request that claims advisory cannot skip shadow → blocking.
  const lie = aiModeCheck(def, fx('showcase/fixtures/review/promote-skip-claims-advisory.yaml'), { repo: repo('shadow') });
  assert.equal(lie.result.status, 'FAIL');
  assert.deepEqual(lie.decision.problems.map((p) => p.ruleId), ['review.mode-skip', 'review.current-mismatch']);
  assert.equal(lie.decision.mode, 'shadow');
  // The same request is a legal one-step promotion only when the descriptor really says advisory.
  const real = aiModeCheck(def, { ...fx('showcase/fixtures/review/promote-skip-claims-advisory.yaml') }, { repo: repo('advisory') });
  assert.equal(real.result.status, 'PASS');
  assert.equal(real.decision.mode, 'blocking');
  // No trusted repository → ERROR, never a decision from the request; an undeclared surface throws.
  assert.equal(aiModeCheck(def, fx('showcase/fixtures/review/promote-advisory.yaml')).result.status, 'ERROR');
  assert.throws(() => currentModeFromDescriptor(repo('shadow'), 'admin/unknown'), /0 descriptor/);
});

// ---------------------------------------------------------------- SC-15 autonomy, breakers, Shepherd, incident
const facts = fx('showcase/fixtures/autonomy/facts-docs-link-fix.yaml');
const closed = fx('showcase/fixtures/autonomy/breakers-closed.yaml');
const breakerPolicy = readYaml(policyPath('registry', 'trust.yaml')).breakerPolicy;
test('autonomy: FE §10.4 matrix cells; unknown risk or reversibility is worst case', () => {
  assert.equal(matrix('R0', 'LOW').notEligibleLevel, 'A2');
  assert.deepEqual([matrix('R1', 'MEDIUM').eligibleLevel, matrix('R1', 'MEDIUM').notEligibleLevel], ['A1', 'A2']);
  assert.equal(matrix('R1', 'LOW').notEligibleLevel, 'A3');
  assert.equal(matrix('R2', 'HIGH').notEligibleLevel, 'A2');
  assert.equal(matrix('R3', 'HIGH').eligibleLevel, 'A3');
  assert.equal(matrix(undefined, 'HIGH').eligibleLevel, 'A3');
  assert.equal(matrix('R0', undefined).notEligibleLevel, 'A2');
});
test('autonomy: each zero-human condition, when broken, falls back to A1 (decision only; pilot applies A1 even for A0)', () => {
  const ok = decideAutonomy({ ...facts, trustLevel: 'T2' }, closed);
  assert.equal(ok.level, 'A0');
  assert.equal(ok.pilot.applied, 'A1');
  const cases = {
    'autonomy.not-eligible': { trustLevel: 'T1' },
    'autonomy.not-opted-in': { surfaces: [{ id: 'docs', zeroHuman: false, aiMode: 'blocking' }] },
    'autonomy.ai-review-not-blocking': { surfaces: [{ id: 'docs', zeroHuman: true, aiMode: 'advisory' }] },
    'autonomy.dismissal': { aiReview: { openFindings: 0, dismissals: 1 } },
    'autonomy.gates': { deterministicGatesPass: false },
    'autonomy.control-file': { controlFilesTouched: [{ path: 'factory.yaml' }] },
    'autonomy.release-freeze': { releaseFreeze: true },
    'autonomy.local-agent': { localAgent: true },
  };
  for (const [rule, patch] of Object.entries(cases)) {
    const d = decideAutonomy({ ...facts, trustLevel: 'T2', ...patch }, closed);
    assert.equal(d.level, 'A1', rule);
    assert.ok(d.ruleIds.includes(rule), `${rule}: ${d.ruleIds}`);
  }
  assert.equal(decideAutonomy({ ...facts, trustLevel: 'T2', controlFilesTouched: [{ path: 'x', trustedMechanism: true }] }, closed).level, 'A0');
});
test('policy.autonomy: pilot mode comes from registry/checks.yaml, a request claiming pilotMode false cannot enable A0', () => {
  assert.equal(readYaml(policyPath('registry', 'checks.yaml')).mode, 'pilot');
  assert.equal(registryPilotMode(), true);
  const req = fx('showcase/fixtures/autonomy/request-proposed-a0-claims-pilot-off.yaml');
  assert.equal(req.pilotMode, false);
  const { result, decision } = autonomyCheck(targetDef('policy.autonomy'), req);
  assert.equal(decision.level, 'A0');
  assert.deepEqual(decision.pilot.a0Allowed, false);
  assert.equal(decision.pilot.applied, 'A1');
  assert.equal(result.status, 'FAIL');
  assert.ok(result.findings.some((f) => f.ruleId === 'autonomy.a0-pilot-forbidden'));
  // Removing the claim changes nothing: the request never carried the policy state.
  const { pilotMode, ...honest } = req;
  assert.equal(autonomyCheck(targetDef('policy.autonomy'), honest).result.status, 'FAIL');
});
test('breakers: tighten automatically; loosen only by surface owner + Factory owner with evidence', () => {
  const sig = fx('showcase/fixtures/autonomy/signals-a0-revert.yaml').signals;
  const { state, tripped } = applySignals(closed, sig, breakerPolicy, { now: '2026-11-20T12:00:00Z' });
  assert.deepEqual(tripped, ['surface:docs:zero-human-revert']);
  assert.deepEqual(validate('breaker-state', state), []);
  assert.deepEqual(applySignals(state, sig, breakerPolicy, { now: '2026-11-20T12:00:00Z' }).tripped, [], 'already tripped: idempotent');
  const id = tripped[0];
  const owners = { surfaceOwner: 'user:docs-owner', factoryOwner: 'user:factory-owner', at: '2026-11-21T00:00:00Z' };
  assert.ok(loosen(state, id, { ...owners, decidedBy: ['user:docs-owner'], evidence: 'review' }).problems.length);
  assert.ok(loosen(state, id, { ...owners, decidedBy: ['user:docs-owner', 'user:factory-owner'] }).problems.some((p) => /evidence/.test(p)));
  assert.ok(loosen(state, id, { ...owners, decidedBy: ['agent:x', 'user:docs-owner', 'user:factory-owner'], evidence: 'e' }).problems.some((p) => /agent/.test(p)));
  const ok = loosen(state, id, { ...owners, decidedBy: ['user:docs-owner', 'user:factory-owner'], evidence: 'post-revert review PIR-12' });
  assert.deepEqual(ok.problems, []);
  assert.equal(trippedFor(ok.state, { surfaces: ['docs'] }).length, 0);
  assert.deepEqual(validate('breaker-state', ok.state), []);
});
test('breakers: minimum sample for rates; two early indicators pause; old signals outside the window do not count', () => {
  const now = '2026-11-20T12:00:00Z';
  const reverts = [1, 2].map((i) => ({ kind: 'revert', surface: 'docs', change: `PR-${i}`, mergedVia: 'A1', at: '2026-11-18T00:00:00Z' }));
  assert.deepEqual(applySignals(closed, reverts, breakerPolicy, { now, changesInWindow: { docs: 5 } }).tripped, [], '2 of 5 is not a rate signal');
  assert.deepEqual(applySignals(closed, reverts, breakerPolicy, { now, changesInWindow: { docs: 25 } }).tripped, ['surface:docs:revert-rate']);
  const early = [{ kind: 'hotfix-48h', surface: 'docs', at: '2026-11-18T00:00:00Z' }, { kind: 'shepherd-pause', surface: 'docs', at: '2026-11-19T00:00:00Z' }];
  assert.deepEqual(applySignals(closed, early, breakerPolicy, { now }).tripped, ['surface:docs:early-indicators']);
  assert.deepEqual(applySignals(closed, [{ ...early[0], at: '2026-09-01T00:00:00Z' }, { ...early[1], at: '2026-09-02T00:00:00Z' }], breakerPolicy, { now }).tripped, []);
});
test('breaker-sod: without a tripped breaker the in-team sign-off counts (the SC-15 FAIL is breaker-driven)', () => {
  const req = fx('showcase/fixtures/autonomy/sod-signoff-breaker.yaml');
  const quiet = breakerStateFor({ ...req, signals: 'showcase/fixtures/autonomy/signals-none.yaml' });
  assert.equal(trippedFor(quiet.state, { surfaces: ['docs'], taskClass: 'docs.link-fix' }).length, 0);
  const sod = readJson(policyPath('showcase/fixtures/autonomy/sod-low-signoff.json'));
  assert.equal(sodCheck(checkDef('policy.sod'), { ...sod, breakerTripped: false }).status, 'PASS');
  assert.equal(KINDS['breaker-sod']({ input: 'showcase/fixtures/autonomy/sod-signoff-breaker.yaml' }).checks[0].status, 'FAIL');
});
test('Change Shepherd: only role tools; R3 or no alert is not automated; human-only actions refused', () => {
  const flags = fx('showcase/fixtures/ops/flags.yaml').flags;
  const off = { tool: 'flag.return-to-safe-state', flag: 'admin.export-dialog-v2', value: 'off', alert: 'A-1', at: 't' };
  assert.equal(evaluateShepherdAction(off, { tier: 'R1', flags }).allowed, true);
  assert.equal(evaluateShepherdAction(off, { tier: 'R3', flags }).problems[0].ruleId, 'ops.shepherd-tier');
  assert.equal(evaluateShepherdAction({ ...off, alert: undefined }, { tier: 'R1', flags }).problems[0].ruleId, 'ops.no-alert');
  for (const tool of ['artifact.rollback', 'data.recover', 'git.revert-main']) assert.equal(evaluateShepherdAction({ tool, alert: 'A-1', at: 't' }, { tier: 'R1', flags }).problems[0].ruleId, 'ops.shepherd-out-of-scope');
  const role = readYaml(policyPath('agents', 'roles', 'change-shepherd.yaml'));
  for (const t of role.tools) assert.ok(sandboxPolicy.toolCatalog[t], `${t} in the sandbox catalog`);
  assert.equal(role.egress, 'none');
});
test('incident review: a checklist by default, misrouting and no eval case are refused; agent-confirmed locations too', () => {
  const bad = reviewIncident(fx('showcase/fixtures/ops/incident-review-checklist.yaml')).problems.map((p) => p.ruleId);
  for (const r of ['incident.root-cause', 'incident.checklist-default', 'incident.misrouted', 'incident.no-eval-case']) assert.ok(bad.includes(r), r);
  const good = fx('showcase/fixtures/ops/incident-review.yaml');
  assert.ok(reviewIncident({ ...good, evalCase: { ...good.evalCase, confirmedBy: 'agent:verifier' } }).problems.some((p) => p.ruleId === 'incident.no-eval-case'));
  const out = reviewIncident(good);
  const evalSet = fx('showcase/fixtures/review/eval-set.yaml');
  assert.equal(appendEvalCase(evalSet, out.evalCase).incidents.length, evalSet.incidents.length + 1);
  assert.throws(() => appendEvalCase(appendEvalCase(evalSet, out.evalCase), out.evalCase), /already/);
  assert.equal(reviewIncident({ ...good, attribution: { surface: 'docs' } }).signals[0].surface, 'docs', 'unattributed → counted against the surface');
});
