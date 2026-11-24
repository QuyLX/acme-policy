// Proof for the adapters that run product-installed tools (quality.test → vitest, quality.build → next): fake binaries
// with controlled exit codes prove the exit maps and that the verifier passes its own generated config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDef } from '../lib/registry.mjs';
import { kit, readProjectConfig } from '../lib/kit.mjs';
import { discoverProjects } from '../lib/workspace.mjs';
import { createContext, disposeContext, testCheck, buildCheck, storyInteractionCheck, visualStoriesCheck } from '../adapters/tools.mjs';

// $1=run|build, $2=--config, $3=file. Exit 2 when the verifier's config is missing, else $FAKE_EXIT.
const FAKE = '#!/bin/sh\nif [ "$1" = "run" ] && [ ! -f "$3" ]; then echo "config not found: $3"; exit 2; fi\necho "fake tool $*"\nexit ${FAKE_EXIT:-0}\n';

function repo({ withVitest = true, withNext = true, browser = false, baseline = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'acme-tools-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"r","private":true}');
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - packages/*\n');
  const libEntry = browser
    ? '  lib:\n    kind: react-lib\n    test:\n      environment: jsdom\n      browser: { visual: true }\n'
    : '  lib:\n    kind: node-lib\n    test:\n      environment: node\n';
  writeFileSync(join(dir, 'factory.config.yaml'), `apiVersion: aisf/4.0\nkind: FactoryProjectConfig\nprojects:\n  app:\n    kind: next-app\n${libEntry}`);
  if (baseline) {
    mkdirSync(join(dir, 'packages/lib/test/browser/__screenshots__/x.visual.test.tsx'), { recursive: true });
    writeFileSync(join(dir, `packages/lib/test/browser/__screenshots__/x.visual.test.tsx/a-light-chromium-${process.platform}.png`), '');
  }
  for (const [p, name, bin, present] of [['apps/app', 'app', 'next', withNext], ['packages/lib', 'lib', 'vitest', withVitest]]) {
    mkdirSync(join(dir, p, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, p, 'package.json'), JSON.stringify({ name, private: true, scripts: { test: 'true', build: 'true' } }));
    if (present) {
      writeFileSync(join(dir, p, 'node_modules', '.bin', bin), FAKE);
      chmodSync(join(dir, p, 'node_modules', '.bin', bin), 0o755);
    }
  }
  return dir;
}

function run(check, id, exit, opts) {
  const dir = repo(opts);
  process.env.FAKE_EXIT = String(exit);
  const { config } = readProjectConfig(dir);
  const ctx = createContext({ repo: dir, kit: kit(), config, projects: discoverProjects(dir), executor: 'ci' });
  try {
    return check(checkDef(id), ctx);
  } finally {
    disposeContext(ctx);
    delete process.env.FAKE_EXIT;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('quality.test: vitest exit 0 → PASS, 1 → FAIL, other → ERROR; runs with the verifier-generated config', () => {
  assert.equal(run(testCheck, 'quality.test', 0).status, 'PASS');
  assert.equal(run(testCheck, 'quality.test', 1).status, 'FAIL');
  assert.equal(run(testCheck, 'quality.test', 3).status, 'ERROR');
});
test('quality.test: vitest not installed → ERROR (environment), never PASS', () =>
  assert.equal(run(testCheck, 'quality.test', 0, { withVitest: false }).status, 'ERROR'));
test('quality.test: repo `test` script is never executed (it is `true`, yet a failing tool fails the check)', () =>
  assert.equal(run(testCheck, 'quality.test', 1).status, 'FAIL'));
test('quality.build: next build exit 0 → PASS, 1 → FAIL, missing → ERROR', () => {
  assert.equal(run(buildCheck, 'quality.build', 0).status, 'PASS');
  assert.equal(run(buildCheck, 'quality.build', 1).status, 'FAIL');
  assert.equal(run(buildCheck, 'quality.build', 0, { withNext: false }).status, 'ERROR');
});

test('ds.story-interaction: browser lane runs with the verifier config; exit 1 → FAIL, 0 → PASS', () => {
  assert.equal(run(storyInteractionCheck, 'ds.story-interaction', 0, { browser: true }).status, 'PASS');
  assert.equal(run(storyInteractionCheck, 'ds.story-interaction', 1, { browser: true }).status, 'FAIL');
});
test('visual.stories: no baseline for this platform → NOT_ASSESSED (never PASS, never updated by the verifier)', () =>
  assert.equal(run(visualStoriesCheck, 'visual.stories', 0, { browser: true }).status, 'NOT_ASSESSED'));
test('visual.stories: with baselines, exit 1 (mismatch) → FAIL, 0 → PASS', () => {
  assert.equal(run(visualStoriesCheck, 'visual.stories', 1, { browser: true, baseline: true }).status, 'FAIL');
  assert.equal(run(visualStoriesCheck, 'visual.stories', 0, { browser: true, baseline: true }).status, 'PASS');
});
