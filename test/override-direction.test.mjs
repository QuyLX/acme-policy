// One case per row of tech-design 03-presets §5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyConfigChange } from '../checks/meta/override-direction.mjs';

const cfg = (lib) => ({ projects: { lib: { kind: 'node-lib', ...lib } } });
const dirs = (base, head) => classifyConfigChange(base, head).map((c) => c.direction);

test('no change → nothing', () => assert.deepEqual(dirs(cfg({}), cfg({})), []));
test('lint rule added at error → tighten', () => assert.deepEqual(dirs(cfg({}), cfg({ lint: { rules: { 'no-console': 'error' } } })), ['tighten']));
test('lint rule added as off → loosen', () => assert.deepEqual(dirs(cfg({}), cfg({ lint: { rules: { 'no-console': 'off' } } })), ['loosen']));
test('severity raised → tighten; lowered → loosen', () => {
  assert.deepEqual(dirs(cfg({ lint: { rules: { r: 'warn' } } }), cfg({ lint: { rules: { r: ['error', {}] } } })), ['tighten']);
  assert.deepEqual(dirs(cfg({ lint: { rules: { r: 'error' } } }), cfg({ lint: { rules: { r: 'warn' } } })), ['loosen']);
});
test('rule override removed: was error → loosen; was off → tighten', () => {
  assert.deepEqual(dirs(cfg({ lint: { rules: { r: 'error' } } }), cfg({})), ['loosen']);
  assert.deepEqual(dirs(cfg({ lint: { rules: { r: 'off' } } }), cfg({})), ['tighten']);
});
test('lint ignore added → loosen', () => assert.deepEqual(dirs(cfg({}), cfg({ lint: { ignores: ['src/legacy/**'] } })), ['loosen']));
test('type-checked path added → tighten; removed → loosen', () => {
  assert.deepEqual(dirs(cfg({}), cfg({ typescript: { extraInclude: ['scripts/**/*.ts'] } })), ['tighten']);
  assert.deepEqual(dirs(cfg({ typescript: { extraInclude: ['scripts/**/*.ts'] } }), cfg({})), ['loosen']);
});
test('types, paths, environment, setupFiles → neutral', () => {
  assert.deepEqual(dirs(cfg({}), cfg({ typescript: { types: ['node'], paths: { '@/*': ['./src/*'] } } })), ['neutral', 'neutral']);
  assert.deepEqual(dirs(cfg({ test: { environment: 'node' } }), cfg({ test: { environment: 'jsdom', setupFiles: ['t.ts'] } })), ['neutral', 'neutral']);
});
test('coverage raised → tighten; lowered or removed → loosen', () => {
  assert.deepEqual(dirs(cfg({ test: { coverage: { lines: 70 } } }), cfg({ test: { coverage: { lines: 80 } } })), ['tighten']);
  assert.deepEqual(dirs(cfg({ test: { coverage: { lines: 80 } } }), cfg({ test: { coverage: { lines: 70 } } })), ['loosen']);
  assert.deepEqual(dirs(cfg({ test: { coverage: { lines: 80 } } }), cfg({ test: {} })), ['loosen']);
});
test('tests switched off for a project → loosen', () => assert.ok(dirs(cfg({ test: { environment: 'node' } }), cfg({})).includes('loosen')));
test('baseline entry added or raised → loosen; ratcheted down → tighten', () => {
  const e = (count) => ({ baseline: [{ rule: 'r', file: 'a.ts', count }] });
  assert.deepEqual(dirs(cfg({}), cfg(e(2))), ['loosen']);
  assert.deepEqual(dirs(cfg(e(1)), cfg(e(2))), ['loosen']);
  assert.deepEqual(dirs(cfg(e(2)), cfg(e(1))), ['tighten']);
  assert.deepEqual(dirs(cfg(e(1)), cfg({})), ['tighten']);
});
test('project added → neutral; removed → loosen; kind changed → loosen', () => {
  assert.deepEqual(dirs({ projects: {} }, cfg({})), ['neutral']);
  assert.deepEqual(dirs(cfg({}), { projects: {} }), ['loosen']);
  assert.deepEqual(dirs(cfg({}), { projects: { lib: { kind: 'node-tool' } } }), ['loosen']);
});
test('first introduction of factory.config.yaml (no base) classifies every entry', () => assert.deepEqual(dirs(null, cfg({})), ['neutral']));
