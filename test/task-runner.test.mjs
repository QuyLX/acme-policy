import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readYaml, policyPath } from '../lib/io.mjs';
import { evaluateWhen, deriveTask, classifyPlaybookChange } from '../lib/task-runner.mjs';
import { readEvents, loadPlaybook } from '../checks/workflow/conformance.mjs';

const fx = (f) => readEvents(policyPath('checks/workflow/fixtures', f));
const codes = (f, extra = []) => {
  const events = fx(f);
  const pb = loadPlaybook(events[0].data.workflow, [policyPath('checks/workflow/fixtures/playbooks'), ...extra]);
  return deriveTask(events, pb, { policyCost: 20 });
};

test('when: OR of ANDs; arrays match by membership; unknown facts count as true (worst case)', () => {
  assert.equal(evaluateWhen('tier == High OR reversibility == LOW', { tier: 'Medium', reversibility: 'HIGH' }), false);
  assert.equal(evaluateWhen('tier == High OR reversibility == LOW', { tier: 'High' }), true);
  assert.equal(evaluateWhen('touches == public-api', { touches: ['module', 'public-api'] }), true);
  assert.equal(evaluateWhen('tier == High', {}), true);
});
test('happy path: MERGED, no violations, every handoff accepted', () => {
  const d = codes('happy.jsonl');
  assert.equal(d.task.state, 'MERGED');
  assert.deepEqual(d.violations, []);
  assert.ok(d.handoffs.every((h) => h.status === 'accepted'));
});
test('SC-21: handoff with implementer notes is rejected with what is missing and what leaked', () => {
  const h = codes('handoff-leak.jsonl').handoffs.find((x) => x.to.role === 'verifier');
  assert.equal(h.status, 'rejected');
  assert.deepEqual(h.missing, ['head-sha']);
  assert.match(h.problems.join(' '), /implementer-notes, reasoning/);
});
test('SC-21: timeouts and ERRORs do not consume the repair-loop budget', () => {
  const d = codes('timeouts-no-budget.jsonl');
  assert.equal(d.task.verifyFails, 0);
  assert.deepEqual(d.violations, []);
});
test('SC-08: a non-converging repair loop escalates', () => {
  const d = codes('verify-loop.jsonl');
  assert.equal(d.task.state, 'ESCALATED');
  assert.equal(d.violations[0].code, 'WF-LOOP');
});
test('SC-08: cost warning at 80% and stop at the ceiling', () => {
  const events = fx('happy.jsonl').map((e) => (e.type === 'cost.reported' ? { ...e, data: { amount: 17, unit: 'usd' } } : e));
  const d = deriveTask(events, loadPlaybook('bug-fix@1.0.0'), { policyCost: 20 });
  assert.match(d.warnings.join(' '), /80%/);
  assert.equal(codes('cost-ceiling.jsonl').violations[0].code, 'WF-COST');
});
test('SC-21: dropping a checkpoint from a playbook is loosening (R3, MET-03)', () => {
  const base = readYaml(policyPath('workflows/bug-fix.yaml'));
  const head = readYaml(policyPath('checks/workflow/fixtures/bug-fix-no-plan-review.yaml'));
  assert.deepEqual(classifyPlaybookChange(base, head).map((c) => c.direction), ['loosen']);
  assert.deepEqual(classifyPlaybookChange(base, base), []);
});
