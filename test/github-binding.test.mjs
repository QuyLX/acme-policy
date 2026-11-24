import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDef } from '../lib/registry.mjs';
import { readJson, readText, policyPath } from '../lib/io.mjs';
import { validate } from '../lib/schema.mjs';
import { toChangeEvent, toSodInput, areasFromCodeowners } from '../lib/github-event.mjs';
import { attest } from '../lib/attest.mjs';
import { waiverSelfApproval } from '../checks/policy-sod/waiver.mjs';
import { workflowPinCheck } from '../checks/meta/workflow-pin.mjs';
import { runBinding } from '../lib/binding.mjs';

const forged = readJson(policyPath('checks/github/fixtures/forged-requested-by.json'));

test('a Requested-by trailer does not become the requester', () => {
  const event = toChangeEvent(forged.payload);
  const input = toSodInput(event, areasFromCodeowners(forged.codeowners, event.files), { tier: forged.tier });
  assert.deepEqual(validate('change-event', event), []);
  assert.deepEqual(validate('sod-input', input), []);
  assert.equal(event.requester.id, 'QuyLX');
  assert.equal(input.requester.source, 'ci-dispatch');
});

test('waiver self-approval fails and a different login passes', () => {
  const self = readJson(policyPath('checks/github/fixtures/waiver-self.json'));
  const other = readJson(policyPath('checks/github/fixtures/waiver-other.json'));
  const def = checkDef('policy.waiver-approval');
  assert.equal(waiverSelfApproval(def, self.waiver, self.requesterId).status, 'FAIL');
  assert.equal(waiverSelfApproval(def, other.waiver, other.requesterId).status, 'PASS');
});

test('attest rejects a forged verifierRef and accepts the pinned one', () => {
  const bad = readJson(policyPath('checks/github/fixtures/attest-forged.json'));
  const ok = readJson(policyPath('checks/github/fixtures/attest-ok.json'));
  const def = checkDef('provenance.attest');
  assert.equal(attest(def, bad.run, bad).status, 'FAIL');
  assert.equal(attest(def, ok.run, ok).status, 'PASS');
});

test('workflow pin fails when the caller or the preset revision differs', () => {
  const sha = 'a'.repeat(40);
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@acme/presets': `git+https://github.com/QuyLX/acme-policy.git#${sha}` } }));
    const missing = workflowPinCheck(checkDef('meta.workflow-pin'), dir, { policySha: sha, workflow: 'QuyLX/acme-policy/.github/workflows/verify.yml' });
    assert.equal(missing.status, 'FAIL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow pin passes when both refs contain the SHA', () => {
  const sha = 'a'.repeat(40);
  const dir = mkdtempSync(join(tmpdir(), 'pin-ok-'));
  try {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(dir, '.github', 'workflows', 'verify.yml'), `uses: QuyLX/acme-policy/.github/workflows/verify.yml@${sha}\n`);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@acme/presets': `git+https://github.com/QuyLX/acme-policy.git#${sha}` } }));
    const result = workflowPinCheck(checkDef('meta.workflow-pin'), dir, { policySha: sha, workflow: 'QuyLX/acme-policy/.github/workflows/verify.yml' });
    assert.equal(result.status, 'PASS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an all-zero pin fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-zero-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{}');
    const result = workflowPinCheck(checkDef('meta.workflow-pin'), dir, { policySha: '0'.repeat(40), workflow: 'x' });
    assert.equal(result.status, 'FAIL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('break-glass cases and the drill log', () => {
  assert.equal(runBinding('break-glass', 'checks/github/fixtures/break-glass-docs.json').checks[0].status, 'PASS');
  for (const name of ['break-glass-one-login', 'break-glass-same-login', 'break-glass-control-file', 'break-glass-expired']) {
    assert.equal(runBinding('break-glass', `checks/github/fixtures/${name}.json`).checks[0].status, 'FAIL', name);
  }
  const drill = readText(policyPath('runbooks/drills/2026-11-24.md'));
  assert.match(drill, /QuyLX/);
  assert.match(drill, /quylx1/);
  assert.match(drill, /DV-07/);
});
