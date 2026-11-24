import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJson, policyPath } from '../lib/io.mjs';
import { checkDef } from '../lib/registry.mjs';
import { sodCheck } from '../checks/policy-sod/evaluate.mjs';
import { validate } from '../lib/schema.mjs';

const run = (name) => sodCheck(checkDef('policy.sod'), readJson(policyPath('checks/policy-sod/fixtures', `${name}.json`)));

const cases = [
  ['medium-requester-self-approves', 'FAIL', /independent/, 'SC-03: requester approves the PR of their own agent'],
  ['medium-independent-approves', 'PASS', null, 'Medium: one independent approval on the head SHA'],
  ['medium-stale-approval', 'FAIL', /independent/, 'GOV-06: approval on an older commit is not counted'],
  ['medium-agent-approves', 'FAIL', /independent/, '§9.10 item 1: an agent is never an approver'],
  ['low-owning-team-signoff', 'PASS', null, 'Low, requester owns every area: sign-off is the one approval (A1)'],
  ['low-outside-team-signoff-only', 'FAIL', /code-owner\(console\/compute\)/, 'SC-03: requester outside the team signs off an R1 PR'],
  ['low-unknown-requester', 'FAIL', /code-owner/, 'unknown requester is never eligible (§9.5 rule 4)'],
  ['high-two-independent-one-owner', 'PASS', null, 'High: two independent approvals incl. a code owner'],
  ['high-two-independent-no-owner', 'FAIL', /code-owner/, 'High: two independents but no code owner'],
  ['control-file-without-owner', 'FAIL', /control-file-owner\(apps\/console\/factory.yaml\)/, 'control file changed without its owner'],
  ['control-file-with-owner', 'PASS', null, 'control file owner approval also fills the independent slot (union)'],
];

for (const [fixture, status, reason, title] of cases) {
  test(`${title} → ${status}`, () => {
    const r = run(fixture);
    assert.equal(r.status, status, r.reason);
    if (reason) assert.match(r.reason, reason);
    assert.deepEqual(validate('check-result', r), []);
  });
}

test('rejected approvals are explained', () => {
  const r = run('medium-stale-approval');
  assert.match(r.findings[0].message, /stale/);
});

test('invalid input is ERROR, never PASS', () => {
  const r = sodCheck(checkDef('policy.sod'), { tier: 'Medium' });
  assert.equal(r.status, 'ERROR');
});
