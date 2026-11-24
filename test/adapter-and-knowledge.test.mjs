import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommandCheck } from '../adapters/command-adapter.mjs';
import { knowledgeImpactCheck } from '../checks/knowledge-impact/impact.mjs';
import { checkDef } from '../lib/registry.mjs';
import { policyPath } from '../lib/io.mjs';
import { validate } from '../lib/schema.mjs';

const def = (command, timeoutSeconds = 10) => ({
  checkId: 'test.probe', checkVersion: '1.0.0', requirement: 'required', enforcement: 'blocking', severity: 'BLOCKER', gate: 'merge', command, timeoutSeconds,
});

test('adapter: exit 0 → PASS', () => assert.equal(runCommandCheck(def(['node', '-e', 'process.exit(0)']), { cwd: '.' }).status, 'PASS'));
test('adapter: exit 1 → FAIL with reason', () => {
  const r = runCommandCheck(def(['node', '-e', 'console.log("boom"); process.exit(1)']), { cwd: '.' });
  assert.equal(r.status, 'FAIL');
  assert.match(r.reason, /boom/);
});
test('adapter: exit 2 → ERROR (infrastructure, not the change)', () => assert.equal(runCommandCheck(def(['node', '-e', 'process.exit(2)']), { cwd: '.' }).status, 'ERROR'));
test('adapter: timeout → ERROR', () => {
  const r = runCommandCheck(def(['node', '-e', 'setTimeout(()=>{}, 5000)'], 1), { cwd: '.' });
  assert.equal(r.status, 'ERROR');
  assert.match(r.reason, /timeout/);
});
test('adapter: missing tool → ERROR', () => assert.equal(runCommandCheck(def(['definitely-not-a-binary-xyz']), { cwd: '.' }).status, 'ERROR'));
test('adapter results conform to the CheckResult schema', () => {
  assert.deepEqual(validate('check-result', runCommandCheck(def(['node', '-e', 'process.exit(1)']), { cwd: '.' })), []);
});

const repo = policyPath('checks/knowledge-impact/fixtures/repo');
test('knowledge.impact: change under `describes` lists the artifact and its authority', () => {
  const r = knowledgeImpactCheck(checkDef('knowledge.impact'), repo, ['src/retry/index.ts']);
  assert.equal(r.status, 'PASS');
  assert.equal(r.extensions['x-affected'][0].id, 'ADR-PIPE-0001');
  assert.ok(r.findings.some((f) => f.ruleId === 'knowledge.impact' && /authority: decision/.test(f.message)));
});
test('knowledge.impact: unrelated change affects nothing', () => {
  const r = knowledgeImpactCheck(checkDef('knowledge.impact'), repo, ['src/other.ts']);
  assert.deepEqual(r.extensions['x-affected'], []);
});
test('invalid frontmatter is reported by knowledge.record-schema, not by knowledge.impact (M2 split)', async () => {
  const { recordSchemaCheck } = await import('../checks/knowledge/record-schema.mjs');
  const r = recordSchemaCheck(checkDef('knowledge.record-schema'), repo);
  assert.ok(r.findings.some((f) => f.ruleId === 'knowledge.record-schema' && f.location === 'docs/broken.md'));
  assert.ok(!knowledgeImpactCheck(checkDef('knowledge.impact'), repo, []).findings.some((f) => f.location === 'docs/broken.md'));
});
