// Proof for deps.policy (FE-DEP-001, CORE-DEP-02/03) and build.install-frozen (FE §19.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readYaml, policyPath } from '../lib/io.mjs';
import { checkDef } from '../lib/registry.mjs';
import { evaluateDeps, licenseAllowed, installedPackages, depsPolicyCheck } from '../checks/deps/policy.mjs';
import { lintLockfile, installFrozenCheck } from '../checks/build/install-frozen.mjs';

const policy = readYaml(policyPath('registry', 'deps-policy.yaml'));
const pkg = (name, license) => ({ name, version: '1.0.0', license });
const adv = (severity) => ({ id: 'GHSA-x', module: 'm', severity, title: 't', versions: ['1.0.0'] });

test('licenses: allowlisted, SPDX OR/AND, unknown', () => {
  assert.ok(licenseAllowed('MIT', policy.licenses.allow));
  assert.ok(licenseAllowed('(MIT OR GPL-3.0)', policy.licenses.allow));
  assert.ok(!licenseAllowed('MIT AND GPL-3.0', policy.licenses.allow));
  assert.ok(!licenseAllowed(null, policy.licenses.allow));
});
test('deps.policy: a GPL or unknown license fails', () => {
  assert.equal(evaluateDeps({ packages: [pkg('a', 'GPL-3.0')], advisories: [], policy, isNew: () => true }).fail, true);
  assert.equal(evaluateDeps({ packages: [pkg('a', null)], advisories: [], policy, isNew: () => true }).fail, true);
  assert.equal(evaluateDeps({ packages: [pkg('a', 'Apache-2.0')], advisories: [], policy, isNew: () => true }).fail, false);
});
test('deps.policy: a reviewed exception covers only its package pattern AND the reviewed license', () => {
  assert.equal(evaluateDeps({ packages: [pkg('@img/sharp-libvips-linux-x64', 'LGPL-3.0-or-later')], advisories: [], policy, isNew: () => true }).fail, false);
  assert.equal(evaluateDeps({ packages: [pkg('@img/sharp-libvips-linux-x64', 'GPL-3.0')], advisories: [], policy, isNew: () => true }).fail, true);
  assert.equal(evaluateDeps({ packages: [pkg('some-mpl-lib', 'MPL-2.0')], advisories: [], policy, isNew: () => true }).fail, true);
  assert.equal(evaluateDeps({ packages: [pkg('@acme/presets', null)], advisories: [], policy, isNew: () => true }).fail, false, 'first-party kit with no license is a reviewed exception (D-29)');
  assert.equal(evaluateDeps({ packages: [pkg('@acme/presets', 'GPL-3.0')], advisories: [], policy, isNew: () => true }).fail, true);
  assert.equal(evaluateDeps({ packages: [pkg('other-pkg', null)], advisories: [], policy, isNew: () => true }).fail, true);
});
test('deps.policy: a high advisory introduced by the change blocks; a pre-existing one is a warning with its SLA', () => {
  assert.equal(evaluateDeps({ packages: [], advisories: [adv('high')], policy, isNew: () => true }).fail, true);
  const pre = evaluateDeps({ packages: [], advisories: [adv('high')], policy, isNew: () => false });
  assert.equal(pre.fail, false);
  assert.match(pre.findings[0].message, /Pre-existing; remediate within 30 days/);
  assert.equal(evaluateDeps({ packages: [], advisories: [adv('moderate')], policy, isNew: () => true }).fail, false);
});
test('deps.policy: no manifest or lockfile change → PASS without scanning', () =>
  assert.equal(depsPolicyCheck(checkDef('deps.policy'), { repo: '/nonexistent', policy, changed: ['src/a.ts'], isNew: () => true, timeoutSeconds: 5 }).status, 'PASS'));
test('deps.policy: dependencies not installed → ERROR (environment)', () =>
  assert.equal(depsPolicyCheck(checkDef('deps.policy'), { repo: tmpdir(), policy, changed: ['package.json'], isNew: () => true, timeoutSeconds: 5 }).status, 'ERROR'));
test('installed packages are read from the pnpm store layout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acme-deps-'));
  try {
    const p = join(dir, 'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad');
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), '{"name":"left-pad","version":"1.3.0","license":"WTFPL"}');
    assert.deepEqual(installedPackages(dir), [{ name: 'left-pad', version: '1.3.0', license: 'WTFPL' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lockfile lint: foreign tarball host and missing integrity are problems', () => {
  const lock = 'lockfileVersion: "9.0"\npackages:\n  a@1.0.0:\n    resolution: {integrity: sha512-x}\n  b@1.0.0:\n    resolution: {tarball: https://evil.example/b.tgz}\n  c@1.0.0:\n    resolution: {}\n';
  const problems = lintLockfile(lock, ['registry.npmjs.org']);
  assert.equal(problems.length, 3); // b: host + no integrity, c: no integrity
});
test('lockfile lint reads every YAML document (pnpm 12 writes several)', () => {
  const lock = '---\nlockfileVersion: "9.0"\npackages:\n  pnpm@12.0.0:\n    resolution: {integrity: sha512-a}\n---\nlockfileVersion: "9.0"\npackages:\n  x@1.0.0:\n    resolution: {}\n';
  assert.deepEqual(lintLockfile(lock, ['registry.npmjs.org']), ['x@1.0.0: no integrity hash']);
});
test('build.install-frozen: lockfile in sync → PASS; manifest changed without lockfile → FAIL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acme-frozen-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"name":"r","private":true}');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n");
    const def = checkDef('build.install-frozen');
    const ok = installFrozenCheck(def, { repo: dir, allowedHosts: ['registry.npmjs.org'], timeoutSeconds: 60 });
    assert.equal(ok.status, 'PASS', ok.reason);
    writeFileSync(join(dir, 'package.json'), '{"name":"r","private":true,"dependencies":{"left-pad":"1.3.0"}}');
    const bad = installFrozenCheck(def, { repo: dir, allowedHosts: ['registry.npmjs.org'], timeoutSeconds: 60 });
    assert.equal(bad.status, 'FAIL', bad.reason);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
