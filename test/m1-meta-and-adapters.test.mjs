import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policyPath } from '../lib/io.mjs';
import { checkDef } from '../lib/registry.mjs';
import { kit } from '../lib/kit.mjs';
import { repoFiles, verifyFiles } from '../lib/config-gen.mjs';
import { discoverProjects } from '../lib/workspace.mjs';
import { validate } from '../lib/schema.mjs';
import { parityProblems } from '../checks/meta/config-parity.mjs';
import { toolchainPinCheck } from '../checks/meta/toolchain-pin.mjs';
import { mapExit, createContext, disposeContext, typecheckCheck, lintCheck } from '../adapters/tools.mjs';
import { adapterDef, readProjectConfig } from '../lib/kit.mjs';

const K = kit();
function fixtureCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'acme-m1-'));
  cpSync(policyPath('showcase/fixtures/ts-repo'), dir, { recursive: true });
  return dir;
}
const ctxFor = (repo) => {
  const { config } = readProjectConfig(repo);
  return createContext({ repo, kit: K, config, projects: discoverProjects(repo), executor: 'ci' });
};

// --- generation ---
test('generation is deterministic and carries the GENERATED header', () => {
  const entry = { kind: 'next-app' };
  assert.deepEqual(repoFiles(entry, { kitVersion: '1.0.0', boundaries: true, projectDir: 'apps/admin' }), repoFiles(entry, { kitVersion: '1.0.0', boundaries: true, projectDir: 'apps/admin' }));
  const files = repoFiles(entry, { kitVersion: '1.0.0', boundaries: true, projectDir: 'apps/admin' });
  assert.match(files['eslint.config.mjs'], /^\/\/ GENERATED .*FE-CFG-001/);
  assert.match(files['tsconfig.json'], /"extends": "\.\.\/\.\.\/\.factory\/kit\/tsconfig\/nextjs\.json"/);
});
test('node-tool projects get lint config only; projects with tests get a vitest config', () => {
  assert.deepEqual(Object.keys(repoFiles({ kind: 'node-tool' }, { kitVersion: '1.0.0', boundaries: false })), ['eslint.config.mjs']);
  assert.ok('vitest.config.ts' in repoFiles({ kind: 'react-lib', test: {} }, { kitVersion: '1.0.0', boundaries: false }));
});
test('verify files import the pinned kit by absolute path, never the product dependency', () => {
  const v = verifyFiles({ kind: 'react-lib', test: {} }, { kitDir: K.dir, kitVersion: K.version, boundaries: true });
  assert.match(v.eslint, /from 'file:\/\//);
  assert.doesNotMatch(v.eslint, /'@acme\/presets/);
  assert.match(v.vitest, /from 'file:\/\//);
  assert.match(v.tsconfig, new RegExp(K.dir.replace(/[/\\.]/g, '\\$&')));
});
test('factory.config.yaml schema: strictness flags cannot be overridden', () => {
  const bad = { apiVersion: 'aisf/4.0', kind: 'FactoryProjectConfig', projects: { lib: { kind: 'node-lib', typescript: { strict: false } } } };
  assert.notDeepEqual(validate('factory-project-config', bad), []);
});

// --- meta.config-parity ---
test('parity: clean fixture → no problems', () => {
  const repo = fixtureCopy();
  try { assert.deepEqual(parityProblems(repo, K.version, K.dir), []); } finally { rmSync(repo, { recursive: true, force: true }); }
});
test('parity: hand-edited generated file → problem', () => {
  const repo = fixtureCopy();
  try {
    writeFileSync(join(repo, 'packages/lib/eslint.config.mjs'), 'export default [];\n');
    assert.match(parityProblems(repo, K.version, K.dir)[0].message, /FE-CFG-001/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test('parity: undeclared workspace project and unknown declared project → problems', () => {
  const repo = fixtureCopy();
  try {
    mkdirSync(join(repo, 'packages/extra'));
    writeFileSync(join(repo, 'packages/extra/package.json'), '{"name":"extra"}');
    writeFileSync(join(repo, 'factory.config.yaml'), readFileSync(join(repo, 'factory.config.yaml'), 'utf8') + '  ghost:\n    kind: node-lib\n');
    const msgs = parityProblems(repo, K.version, K.dir).map((p) => p.message).join('\n');
    assert.match(msgs, /"extra" is not declared/);
    assert.match(msgs, /"ghost" is declared but is not a workspace project/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
test('parity: missing factory.config.yaml → problem', () => {
  const repo = fixtureCopy();
  try {
    rmSync(join(repo, 'factory.config.yaml'));
    assert.match(parityProblems(repo, K.version, K.dir)[0].message, /missing/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

// --- meta.toolchain-pin ---
function pinRepo(nxVersion) {
  const repo = mkdtempSync(join(tmpdir(), 'acme-pin-'));
  writeFileSync(join(repo, 'package.json'), '{"name":"r","devDependencies":{"@acme/presets":"link:x"}}');
  writeFileSync(join(repo, 'pnpm-workspace.yaml'), 'packages: []\n');
  writeFileSync(join(repo, 'nx.json'), '{}');
  writeFileSync(join(repo, 'factory.config.yaml'), 'apiVersion: aisf/4.0\nkind: FactoryProjectConfig\nprojects:\n  r:\n    kind: node-lib\n');
  if (nxVersion) {
    mkdirSync(join(repo, 'node_modules/nx'), { recursive: true });
    writeFileSync(join(repo, 'node_modules/nx/package.json'), JSON.stringify({ version: nxVersion }));
  }
  return repo;
}
test('toolchain-pin: product tool at the pinned version → PASS', () => {
  const repo = pinRepo(K.productTools.nx);
  try { assert.equal(toolchainPinCheck(checkDef('meta.toolchain-pin'), repo, K).status, 'PASS'); } finally { rmSync(repo, { recursive: true, force: true }); }
});
test('toolchain-pin: PR bumps a product tool → FAIL', () => {
  const repo = pinRepo('99.0.0');
  try { assert.equal(toolchainPinCheck(checkDef('meta.toolchain-pin'), repo, K).status, 'FAIL'); } finally { rmSync(repo, { recursive: true, force: true }); }
});
test('toolchain-pin: tool not installed → ERROR (environment), never PASS', () => {
  const repo = pinRepo(null);
  try { assert.equal(toolchainPinCheck(checkDef('meta.toolchain-pin'), repo, K).status, 'ERROR'); } finally { rmSync(repo, { recursive: true, force: true }); }
});

// --- adapter exit maps ---
test('exit maps: eslint 0/1/2 → PASS/FAIL/ERROR', () => {
  const a = adapterDef('eslint');
  assert.deepEqual([0, 1, 2].map((c) => mapExit(a, c)), ['PASS', 'FAIL', 'ERROR']);
});
test('exit maps: tsc exits 2 on type errors → FAIL; 1 (bad invocation) → ERROR; 2 without diagnostics → ERROR', () => {
  const a = adapterDef('tsc');
  assert.equal(mapExit(a, 2, 'src/a.ts(1,7): error TS2322: Type'), 'FAIL');
  assert.equal(mapExit(a, 1, 'error TS5058: The specified path does not exist'), 'ERROR');
  assert.equal(mapExit(a, 2, 'Segmentation fault'), 'ERROR');
});
test('exit maps: signal or unknown code → ERROR', () => {
  assert.equal(mapExit(adapterDef('vitest'), null), 'ERROR');
  assert.equal(mapExit(adapterDef('vitest'), 3), 'ERROR');
});

// --- real tool runs on the fixture (mutation proof for the adapters) ---
test('typecheck adapter: clean fixture → PASS; seeded type error → FAIL (not ERROR)', () => {
  const repo = fixtureCopy();
  const ctx = ctxFor(repo);
  try {
    assert.equal(typecheckCheck(checkDef('quality.typecheck'), ctx).status, 'PASS');
    writeFileSync(join(repo, 'packages/lib/src/broken.ts'), 'export const n: number = "not a number";\n');
    assert.equal(typecheckCheck(checkDef('quality.typecheck'), ctx).status, 'FAIL');
  } finally { disposeContext(ctx); rmSync(repo, { recursive: true, force: true }); }
});
test('lint adapter: seeded violation → FAIL; violation removed → PASS', () => {
  const repo = fixtureCopy();
  const ctx = ctxFor(repo);
  try {
    assert.equal(lintCheck(checkDef('quality.lint'), ctx).status, 'FAIL');
    writeFileSync(join(repo, 'packages/lib/src/index.ts'), 'export function describeValue(input: unknown): string {\n  return String(input);\n}\n');
    assert.equal(lintCheck(checkDef('quality.lint'), ctx).status, 'PASS');
  } finally { disposeContext(ctx); rmSync(repo, { recursive: true, force: true }); }
});
test('adapters leave no verifier files behind in the product tree', () => {
  const repo = fixtureCopy();
  const ctx = ctxFor(repo);
  try {
    typecheckCheck(checkDef('quality.typecheck'), ctx);
    assert.throws(() => readFileSync(join(repo, 'packages/lib/tsconfig.factory-verify.json')));
  } finally { disposeContext(ctx); rmSync(repo, { recursive: true, force: true }); }
});
