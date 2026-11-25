// Group D of tech-design 13: SC-11 product defect packs (authz.*, export.csv-injection) and SC-10 check lifecycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readYaml, policyPath } from '../lib/io.mjs';
import { checkDef } from '../lib/registry.mjs';
import { validate } from '../lib/schema.mjs';
// Loaded through the merge point, as every consumer does (product.mjs → fixture-run.mjs → modules/index.mjs is a cycle).
import { MODULE_KINDS, MODULE_CHECKS } from '../lib/modules/index.mjs';
import { KINDS, CHECKS } from '../lib/modules/product.mjs';
import { permissionMatrixCheck, negativeCheck, stripComments } from '../checks/authz/matrix.mjs';
import { csvInjectionCheck, lintCsv } from '../checks/export/csv-injection.mjs';
import { evaluateWaiver, applyWaiver, inWaiverScope, waiverSelfApproval } from '../checks/policy-sod/waiver.mjs';
import {
  activatedDef, applyBaseline, baselineChange, fpSlo, gateExitCode, promote, snapshotBaseline, trustedMechanisms,
  BASELINE_PRODUCER, DEFAULT_MIN_SHADOW_DAYS,
} from '../lib/check-lifecycle.mjs';

const FIXTURE = policyPath('showcase', 'fixtures', 'admin-authz-repo');
const APP_TESTS = ['apps/admin/src/platform/csv.test.ts', 'apps/admin/src/domains/tenants/server/suspend.authz.test.ts', 'apps/admin/src/domains/tenants/server/read.authz.test.ts', 'apps/admin/src/app/tenants/export/route.authz.test.ts'];

/** A temp copy of the fixture repo with an optional diff applied and extra files written. */
function copyFixture({ change, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acme-product-'));
  cpSync(FIXTURE, dir, { recursive: true });
  if (change) {
    const r = spawnSync('git', ['apply', policyPath(change)], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const withFixture = (opts, fn) => {
  const dir = copyFixture(opts);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
// Outside the parent test runner: a child `node --test` that inherits NODE_TEST_CONTEXT reports to the parent and exits 0.
const { NODE_TEST_CONTEXT: _ctx, ...childEnv } = process.env;
const runAppTests = (dir, files = APP_TESTS) => spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, encoding: 'utf8', env: childEnv });
const rules = (r) => r.findings.map((f) => f.ruleId);

test('group D registers its checks and the check-lifecycle and holdout-recall kinds only in lib/modules/product.mjs', () => {
  assert.deepEqual(Object.keys(CHECKS).sort(), ['authz.negative', 'authz.permission-matrix', 'export.csv-injection']);
  assert.deepEqual(Object.keys(KINDS), ['check-lifecycle', 'holdout-recall']);
  assert.equal(MODULE_KINDS['check-lifecycle'], KINDS['check-lifecycle']);
  assert.equal(MODULE_KINDS['holdout-recall'], KINDS['holdout-recall']);
  for (const id of Object.keys(CHECKS)) assert.equal(MODULE_CHECKS[id], CHECKS[id]);
  for (const id of Object.keys(CHECKS)) {
    const def = checkDef(id);
    assert.equal(def.lifecycle, 'shadow');
    assert.equal(def.autoDemote, false);
    assert.equal(def.basis.class, 'security');
  }
  assert.equal(checkDef('export.csv-injection').baselineable, true);
  assert.ok(readYaml(policyPath('registry', 'control-files.yaml')).paths.includes('**/permissions.yaml'));
});

// --- fixture runtime: the seeded defects are real behavior changes, not only text patterns ---------------------------

test('fixture app tests pass on the clean repo (toCsvCell unit tests, negative authz tests)', () => {
  const r = runAppTests(FIXTURE);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('permission-only-in-ui.diff makes the server grant tenants.suspend to noAccess and support (runtime)', () => {
  withFixture({ change: 'showcase/fixtures/permission-only-in-ui.diff' }, (dir) => {
    const r = runAppTests(dir, ['apps/admin/src/domains/tenants/server/suspend.authz.test.ts']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /not ok .*@persona:noAccess/);
  });
});

test('csv-formula-injection.diff writes the =HYPERLINK cell raw into the export (runtime)', () => {
  withFixture({ change: 'showcase/fixtures/csv-formula-injection.diff' }, (dir) => {
    const r = runAppTests(dir, ['apps/admin/src/app/tenants/export/route.authz.test.ts']);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /not ok .*formula-like text cells are neutralized/);
  });
});

// --- SC-11 hold-out set (FE §12 seeded defects): separate from the dev set, and every variant a real defect ---------

const HOLDOUT = readYaml(policyPath('showcase', 'holdout', 'sc-11', 'manifest.yaml'));
const variants = () => HOLDOUT.classes.flatMap((c) => c.variants.map((v) => ({ ...v, cls: c })));

test('SC-11 hold-out: the four supported classes, each with several variants that apply to the clean repo and are not dev fixtures', () => {
  assert.deepEqual(HOLDOUT.classes.map((c) => c.id), ['tenant-key-client-query-cache', 'tenant-key-server-data-cache', 'permission-only-in-ui', 'csv-formula-injection']);
  const registry = readFileSync(policyPath('registry', 'checks.yaml'), 'utf8');
  const devDiffs = readdirSync(policyPath('showcase', 'fixtures')).filter((f) => f.endsWith('.diff')).map((f) => readFileSync(policyPath('showcase', 'fixtures', f), 'utf8'));
  for (const c of HOLDOUT.classes) {
    assert.ok(c.variants.length >= 4, `${c.id} has ${c.variants.length} variants`);
    assert.ok(checkDef(c.check), `${c.id}: ${c.check} is a registry check`);
    assert.ok(c.rules.length > 0);
  }
  for (const v of variants()) {
    assert.match(v.diff, /^showcase\/holdout\/sc-11\//);
    assert.ok(!registry.includes(v.diff), `${v.diff} is a registry fixture`);
    const text = readFileSync(policyPath(v.diff), 'utf8');
    assert.ok(!devDiffs.includes(text), `${v.diff} duplicates a dev fixture`);
    const dir = mkdtempSync(join(tmpdir(), 'acme-holdout-'));
    try {
      cpSync(policyPath(v.cls.repo), dir, { recursive: true });
      const r = spawnSync('git', ['apply', '--check', policyPath(v.diff)], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, `${v.diff}: ${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('SC-11 hold-out: the authz and CSV variants are real behavior defects (the app tests fail), including the ones the checks miss', () => {
  // delete-action-ui-gate-only adds a new action that no existing app test covers; its defect is shown by the matrix
  // check (client-only permission), so it is not asserted at runtime here.
  const runtime = variants().filter((v) => v.cls.repo === 'showcase/fixtures/admin-authz-repo' && v.id !== 'delete-action-ui-gate-only');
  assert.equal(runtime.length, 8);
  for (const v of runtime) {
    withFixture({ change: v.diff }, (dir) => {
      const r = runAppTests(dir);
      assert.notEqual(r.status, 0, `${v.cls.id}/${v.id}: the app tests still pass, so the variant is not a defect`);
      // The failing test is the behavior the class protects: a forbidden persona, or a neutralized formula cell.
      assert.match(r.stdout, v.cls.id === 'csv-formula-injection' ? /not ok .*formula-like text cells are neutralized/ : /not ok .*@authz:tenants\.\w+ @persona:(support|noAccess)/, `${v.cls.id}/${v.id}`);
    });
  }
});

test('holdout-recall refuses a case without a declared minRecall', () => {
  assert.throws(() => KINDS['holdout-recall']({ manifest: 'showcase/holdout/sc-11/manifest.yaml' }), /minRecall/);
});

test('fixture personas mirror permissions.yaml roles; noAccess is a session with no permissions', async () => {
  const { ROLES, sessionFor } = await import(join(FIXTURE, 'apps/admin/src/testing/personas.ts'));
  const matrix = readYaml(join(FIXTURE, 'apps/admin/permissions.yaml'));
  assert.deepEqual(validate('permission-matrix', matrix), []);
  assert.deepEqual(JSON.parse(JSON.stringify(ROLES)), matrix.roles);
  const s = sessionFor('noAccess', new Date('2026-11-25T00:00:00Z'));
  assert.deepEqual(s.permissions, []);
  assert.ok(s.actor.id && s.tenantId);
});

// --- authz.permission-matrix / authz.negative ---------------------------------------------------------------------

const PM = checkDef('authz.permission-matrix');
const NEG = checkDef('authz.negative');
const ACTION = 'apps/admin/src/domains/tenants/server/suspend.action.ts';
const actionWith = (authorize) => `'use server';\nimport { can } from '../../../platform/authz.ts';\nimport { defineMutation } from '../../../platform/mutation.ts';\nexport const suspendTenant = defineMutation({\n  name: 'tenants.suspend',\n  input: (raw) => raw,\n  ${authorize},\n  handler: async () => ({}),\n});\n`;

test('authz.permission-matrix detects every trivially-true authorize form', () => {
  for (const form of ['authorize: () => true', 'authorize: async () => true', 'authorize: (ctx) => { return true; }', 'authorize: async function () { return true }', 'async authorize(ctx) { return true; }']) {
    withFixture({ files: { [ACTION]: actionWith(form) } }, (dir) => {
      const r = permissionMatrixCheck(PM, { repo: dir });
      assert.equal(r.status, 'FAIL', form);
      assert.ok(rules(r).includes('authz.authorize-trivial'), form);
    });
  }
});

test('authz.permission-matrix: a commented-out guard or a guard for another permission is no guard', () => {
  withFixture({ files: { [ACTION]: actionWith("authorize: (ctx) => /* can(ctx, 'tenants.suspend') */ can(ctx, 'tenants.read')") } }, (dir) => {
    const r = permissionMatrixCheck(PM, { repo: dir });
    assert.ok(rules(r).includes('authz.server-guard-missing'));
    assert.ok(rules(r).includes('authz.client-only-permission'));
    assert.ok(!rules(r).includes('authz.authorize-trivial'));
  });
  assert.equal(stripComments("const u = 'https://x.invalid'; // c\n/* b */ go()"), "const u = 'https://x.invalid'; \n        go()");
});

test('authz.permission-matrix: a client entry, a missing entry and an inconsistent matrix fail; no matrix is NOT_ASSESSED', () => {
  const matrix = readYaml(join(FIXTURE, 'apps/admin/permissions.yaml'));
  matrix.entries[1].path = 'src/domains/tenants/ui/SuspendButton.tsx';
  matrix.entries.push({ id: 'tenants.delete', kind: 'action', path: 'src/domains/tenants/server/delete.action.ts', permission: 'tenants.delete', allow: ['support'], deny: ['staff'] });
  withFixture({ files: { 'apps/admin/permissions.yaml': JSON.stringify(matrix) } }, (dir) => {
    const r = permissionMatrixCheck(PM, { repo: dir });
    assert.ok(r.findings.some((f) => f.ruleId === 'authz.server-guard-missing' && /'use client'/.test(f.message)));
    assert.ok(rules(r).includes('authz.entry-missing'));
    assert.ok(rules(r).includes('authz.matrix-inconsistent'));
  });
  withFixture({ files: { 'apps/admin/permissions.yaml': 'apiVersion: aisf/4.0\nkind: PermissionMatrix\n' } }, (dir) => {
    assert.ok(rules(permissionMatrixCheck(PM, { repo: dir })).includes('authz.matrix-invalid'));
  });
  const empty = mkdtempSync(join(tmpdir(), 'acme-product-empty-'));
  try {
    assert.equal(permissionMatrixCheck(PM, { repo: empty }).status, 'NOT_ASSESSED');
    assert.equal(negativeCheck(NEG, { repo: empty }).status, 'NOT_ASSESSED');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('authz.negative: a tag without signing in as the persona or without a forbidden assertion is vacuous', () => {
  const vacuous = "import { test } from 'node:test';\ntest('@authz:tenants.suspend @persona:noAccess is checked', () => {\n  useSessionProvider(createTestSessionProvider(null));\n  assert.ok(true);\n});\n";
  withFixture({ change: 'showcase/fixtures/negative-test-dropped.diff', files: { 'apps/admin/src/domains/tenants/server/vacuous.authz.test.ts': vacuous } }, (dir) => {
    const r = negativeCheck(NEG, { repo: dir });
    assert.equal(r.status, 'FAIL');
    assert.deepEqual(rules(r), ['authz.negative-vacuous']);
  });
  const matrix = readYaml(join(FIXTURE, 'apps/admin/permissions.yaml'));
  matrix.entries[0].deny = [];
  withFixture({ files: { 'apps/admin/permissions.yaml': JSON.stringify(matrix) } }, (dir) => {
    assert.deepEqual(rules(negativeCheck(NEG, { repo: dir })), ['authz.negative-missing']);
  });
});

// --- export.csv-injection ------------------------------------------------------------------------------------------

const CSV = checkDef('export.csv-injection');

test('export.csv-injection lints TypeScript with the kit parser and ignores test files', () => {
  const ts = "export function GET(rows: Array<{ a: string }>): Response {\n  const body = rows.map((r) => `${r.a},${r.a}`).join('\\n');\n  return new Response(body as string, { headers: { 'content-type': 'text/csv' } });\n}\n";
  assert.deepEqual(lintCsv(ts, 'route.ts').map((m) => m.messageId), ['template', 'response']);
  withFixture({ files: { 'apps/admin/src/app/x/route.test.ts': ts } }, (dir) => assert.equal(csvInjectionCheck(CSV, { repo: dir }).status, 'PASS'));
  withFixture({ files: { 'apps/admin/src/app/x/route.ts': ts } }, (dir) => {
    const r = csvInjectionCheck(CSV, { repo: dir });
    assert.equal(r.status, 'FAIL');
    assert.ok(r.findings.every((f) => /^[0-9a-f]{16}$/.test(f.fingerprint) && f.location.startsWith('apps/admin/src/app/x/route.ts:')));
  });
});

test('export.csv-injection fingerprints survive line shifts', () => {
  const before = withFixture({ change: 'showcase/fixtures/csv-formula-injection.diff' }, (dir) => csvInjectionCheck(CSV, { repo: dir }));
  const after = withFixture({ change: 'showcase/fixtures/csv-formula-injection.diff' }, (dir) => {
    const p = join(dir, 'apps/admin/src/app/tenants/export/route.ts');
    writeFileSync(p, `// moved down\n\n${spawnSync('cat', [p], { encoding: 'utf8' }).stdout}`);
    return csvInjectionCheck(CSV, { repo: dir });
  });
  assert.deepEqual(after.findings.map((f) => f.fingerprint), before.findings.map((f) => f.fingerprint));
  assert.notDeepEqual(after.findings.map((f) => f.location), before.findings.map((f) => f.location));
});

// --- check lifecycle ------------------------------------------------------------------------------------------------

const NOW = '2026-11-25';
const fired = [{ fixture: 'v1', fired: true }];

test('promote follows planned → shadow → active → deprecated; only active may be required', () => {
  const planned = { ...CSV, lifecycle: 'planned' };
  assert.ok(rules(promote(planned, { to: 'active', proof: fired, shadowSince: '2026-01-01', now: NOW })).includes('lifecycle.skip'));
  const toShadow = promote(planned, { to: 'shadow', now: NOW });
  assert.equal(toShadow.allowed, true);
  assert.deepEqual([toShadow.def.requirement, toShadow.def.enforcement], ['optional', 'observe']);
  const active = promote(CSV, { to: 'active', proof: fired, shadowSince: '2026-11-01', now: NOW });
  assert.equal(active.allowed, true);
  assert.deepEqual([active.def.requirement, active.def.enforcement], ['required', 'blocking']);
  assert.equal(promote(active.def, { to: 'deprecated', now: NOW }).def.requirement, 'optional');
  assert.ok(rules(promote(active.def, { to: 'shadow', now: NOW })).includes('lifecycle.invalid-transition'));
  assert.ok(rules(promote(CSV, { to: 'active', proof: fired, shadowSince: '2026-11-12', now: NOW })).includes('lifecycle.shadow-period'));
  assert.equal(DEFAULT_MIN_SHADOW_DAYS, 14);
  assert.ok(rules(promote(CSV, { to: 'active', proof: [], shadowSince: '2026-01-01', now: NOW })).includes('lifecycle.mutation-proof'));
});

test('trusted-mechanisms registry is valid and registers the snapshot and shrink mechanisms with owners', () => {
  const ids = trustedMechanisms().map((m) => m.id);
  assert.deepEqual(ids, [BASELINE_PRODUCER, 'trusted:baseline-shrink']);
  const fail = { checkId: CSV.checkId, checkVersion: '1.0.0', status: 'FAIL', findings: [{ ruleId: 'r', severity: 'BLOCKER', location: 'a.ts:3', message: 'm', fingerprint: 'aaaaaaaaaaaaaaaa' }] };
  assert.equal(snapshotBaseline(fail, { executor: 'local', event: 'push', ref: 'refs/heads/main', takenAt: NOW }).problems[0].ruleId, 'baseline.snapshot-not-ci');
  assert.equal(snapshotBaseline(fail, { executor: 'ci', event: 'push', ref: 'refs/heads/main', takenAt: NOW, producer: 'trusted:other' }).problems[0].ruleId, 'baseline.untrusted-producer');
  const { baseline } = snapshotBaseline(fail, { executor: 'ci', event: 'push', ref: 'refs/heads/main', takenAt: NOW });
  assert.deepEqual(validate('check-baseline', baseline), []);
  // On the target branch a stale entry blocks until the shrink mechanism removes it (Standard §7.5).
  const pass = { ...fail, status: 'PASS', findings: [] };
  const active = activatedDef(CSV);
  assert.equal(applyBaseline(active, pass, baseline).status, 'PASS');
  assert.equal(applyBaseline(active, pass, baseline, { onTarget: true }).status, 'FAIL');
  // The baseline only shrinks.
  assert.deepEqual(baselineChange(null, baseline), []);
  assert.equal(baselineChange(baseline, { ...baseline, producer: 'pr:dev-1', entries: [...baseline.entries, { location: 'b.ts:1', fingerprint: 'bbbbbbbbbbbbbbbb' }] })[0].ruleId, 'baseline.grow');
  assert.deepEqual(baselineChange(baseline, { ...baseline, producer: 'trusted:baseline-shrink', entries: [] }), []);
});

test('fpSlo: autoDemote true proposes demotion; ledger for another owner is rejected', () => {
  const ledger = readYaml(policyPath('showcase', 'fixtures', 'check-lifecycle', 'fp-ledger-owner-confirmed.yaml'));
  const demotable = { ...activatedDef(CSV), autoDemote: true };
  const { result, decision } = fpSlo(demotable, ledger);
  assert.deepEqual([result.status, decision.action, decision.enforcement], ['FAIL', 'demotion-proposal', 'blocking']);
  assert.throws(() => fpSlo({ ...CSV, owner: 'team-other' }, ledger), /owner/);
});

test('gateExitCode honors baselined and waived dispositions only on FAIL', () => {
  const c = { enforcement: 'blocking', requirement: 'required', status: 'FAIL' };
  assert.equal(gateExitCode([c]), 1);
  assert.equal(gateExitCode([{ ...c, disposition: { type: 'baselined' } }]), 0);
  assert.equal(gateExitCode([{ ...c, disposition: { type: 'not-applicable' } }]), 1);
  assert.equal(gateExitCode([{ ...c, enforcement: 'observe' }]), 0);
  assert.equal(gateExitCode([{ ...c, status: 'ERROR' }]), 2);
});

// --- waivers --------------------------------------------------------------------------------------------------------

const APPROVAL = checkDef('policy.waiver-approval');
const approvers = { techLead: 'lead-1', securityOwner: 'sec-owner-1', platformOwner: 'platform-owner-1', dsOwner: 'ds-owner-1', codeOwners: ['lead-1', 'sec-owner-1', 'platform-owner-1'] };
const waiver = (over = {}) => ({ id: 'WVR-2026-0200', checkId: CSV.checkId, scope: 'apps/admin/src/app/tenants/export', reason: 'synthetic waiver for tests', owner: { id: 'dev-1' }, approvedBy: { id: 'lead-1' }, createdAt: '2026-11-25', expiresAt: '2026-12-09', ...over });
const result = { checkId: CSV.checkId, status: 'FAIL', findings: [{ ruleId: 'x', severity: 'BLOCKER', location: 'apps/admin/src/app/tenants/export/route.ts:17' }] };
const evalW = (w, ctx = {}) => evaluateWaiver(APPROVAL, w, { check: activatedDef(CSV), result, requesterId: 'dev-1', approvers, now: '2026-11-26', ...ctx });

test('evaluateWaiver: approver roles of FE §10.5', () => {
  assert.equal(evalW(waiver()).status, 'PASS');
  assert.ok(rules(evalW(waiver(), { check: { ...activatedDef(CSV), baselineable: false } })).includes('waiver.approver-not-permitted'));
  assert.equal(evalW(waiver({ approvedBy: { id: 'sec-owner-1' } }), { check: { ...activatedDef(CSV), baselineable: false } }).status, 'PASS');
  const long = waiver({ expiresAt: '2027-04-01' });
  assert.ok(rules(evalW(long)).includes('waiver.approver-not-permitted'));
  assert.ok(rules(evalW(long)).includes('waiver.expiry-too-long'));
  assert.equal(evalW({ ...long, approvedBy: { id: 'platform-owner-1' } }).status, 'PASS');
  assert.ok(rules(evalW({ ...long, approvedBy: { id: 'sec-owner-1' } }, { check: { ...activatedDef(CSV), baselineable: false } })).includes('waiver.expiry-too-long'));
  assert.ok(rules(evalW(waiver({ approvedBy: { id: 'agent:reviewer' } }))).includes('policy.sod.waiver-self'));
  assert.ok(rules(evalW(waiver({ approvedBy: { id: 'lead-2' } }), { approvers: { ...approvers, techLead: 'lead-2' } })).includes('waiver.approver-not-permitted'), 'a tech lead who is not a code owner of the area');
});

test('evaluateWaiver: scope, check id, expiry and FP SLO limits', () => {
  assert.ok(rules(evalW(waiver({ scope: '**' }))).includes('waiver.out-of-scope'));
  assert.ok(rules(evalW(waiver({ checkId: 'sec.secrets' }))).includes('waiver.out-of-scope'));
  assert.ok(rules(evalW(waiver(), { now: '2026-12-10' })).includes('waiver.expired'));
  assert.ok(rules(evalW(waiver({ expiresAt: '2026-12-10' }), { fpSloExceeded: true })).includes('waiver.expiry-too-long'));
  assert.equal(evalW(waiver({ expiresAt: '2026-12-09' }), { fpSloExceeded: true }).status, 'PASS');
  assert.equal(evalW(waiver({ id: 'bad' })).status, 'ERROR');
  assert.ok(inWaiverScope('apps/admin/src/app/tenants/export/route.ts', 'apps/admin/src/app/tenants/export/'));
  assert.ok(inWaiverScope('apps/admin/src/x.ts', 'packages/**, apps/admin/src/*.ts'));
  assert.ok(!inWaiverScope('apps/admin/src/app/tenants/export-v2/route.ts', 'apps/admin/src/app/tenants/export'));
});

test('applyWaiver sets the waived disposition only after a passing approval; waiverSelfApproval is unchanged', () => {
  const ok = evalW(waiver());
  assert.equal(applyWaiver(result, waiver(), ok).disposition.type, 'waived');
  const bad = evalW(waiver({ approvedBy: { id: 'dev-1' } }));
  assert.equal(applyWaiver(result, waiver(), bad).disposition, undefined);
  assert.equal(waiverSelfApproval(APPROVAL, waiver({ approvedBy: { id: 'dev-1' } }), 'dev-1').status, 'FAIL');
  assert.equal(waiverSelfApproval(APPROVAL, waiver(), 'dev-1').status, 'PASS');
});
