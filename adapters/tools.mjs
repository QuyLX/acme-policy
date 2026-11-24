// Tool adapters (Standard §7.16; FE §8.7 items 3 and 6; tech-design 03-presets §4).
// Each check runs a tool directly, per workspace project, with a config the verifier generates from the pinned kit.
// Repo-defined scripts and repo-committed configs never decide a result (DV-05).
//   eslint, tsc  → binaries from the kit (pinned by this repo's lockfile)
//   vitest, next → binaries from the product install; versions enforced by meta.toolchain-pin
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapterDef } from '../lib/kit.mjs';
import { verifyFiles, VERIFY_FILES, TYPECHECKED } from '../lib/config-gen.mjs';
import { hasNx } from '../lib/workspace.mjs';
import { checkResult } from '../lib/result.mjs';
import { NO_CACHE_ENV } from './command-adapter.mjs';

const RANK = { PASS: 0, FAIL: 1, ERROR: 2 };

/** Maps a tool exit code to a canonical status using the adapter's declared exit map. Unknown codes are ERROR. */
export function mapExit(adapter, code, output = '') {
  if (code === null || code === undefined) return 'ERROR';
  const status = adapter.exit[String(code)];
  if (!status) return 'ERROR';
  if (status === 'FAIL' && adapter.failNeedsOutput && !output.includes(adapter.failNeedsOutput)) return 'ERROR';
  return status;
}

function runTool(adapter, cmd, args, { cwd, env, timeoutSeconds }) {
  if (!existsSync(cmd)) return { status: 'ERROR', tail: `tool not installed: ${cmd}` };
  const proc = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024 });
  const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  const tail = output.trim().split('\n').slice(-20).join('\n');
  if (proc.error?.code === 'ETIMEDOUT') return { status: 'ERROR', tail: `timeout after ${timeoutSeconds}s (environment, not the change)` };
  if (proc.error) return { status: 'ERROR', tail: `could not start ${cmd}: ${proc.error.message}` };
  return { status: mapExit(adapter, proc.status, output), tail: tail || `exit ${proc.status}` };
}

/**
 * Shared state of one verification run.
 * @param {{ repo: string, kit: object, config: object, projects: Array<{name:string,dir:string,abs:string}>, executor: string }} base
 */
export function createContext(base) {
  const env = base.executor === 'local' ? { ...process.env } : { ...process.env, ...NO_CACHE_ENV };
  return { ...base, env, workDir: null, prepared: undefined };
}

export function disposeContext(ctx) {
  if (ctx.workDir) rmSync(ctx.workDir, { recursive: true, force: true });
}

function workDir(ctx) {
  ctx.workDir ??= mkdtempSync(join(tmpdir(), 'acme-verify-'));
  return ctx.workDir;
}

const entries = (ctx) => ctx.projects.filter((p) => ctx.config.projects[p.name]).map((p) => ({ ...p, entry: ctx.config.projects[p.name] }));

/** Builds library packages once per run so typecheck/test/build see their artifacts. Its outcome is not a verdict
 *  by itself: a failure is reported by the check that needed it. */
function prepare(ctx, timeoutSeconds) {
  if (ctx.prepared !== undefined) return ctx.prepared;
  const libs = entries(ctx).filter((p) => p.entry.kind === 'react-lib' || p.entry.kind === 'node-lib');
  if (!libs.length || !hasNx(ctx.repo)) return (ctx.prepared = null);
  const nx = join(ctx.repo, 'node_modules', '.bin', 'nx');
  const r = runTool(adapterDef('build'), nx, ['run-many', '-t', 'build', `--projects=${libs.map((l) => l.name).join(',')}`, '--output-style=static'], { cwd: ctx.repo, env: ctx.env, timeoutSeconds });
  return (ctx.prepared = r.status === 'PASS' ? null : { status: r.status, tail: `prepare (build library packages) failed:\n${r.tail}` });
}

function result(def, adapter, ctx, perProject, startedAt, commandLabel) {
  const worst = perProject.reduce((w, r) => (RANK[r.status] > RANK[w] ? r.status : w), 'PASS');
  const failing = perProject.filter((r) => r.status !== 'PASS');
  return checkResult(def, {
    status: worst,
    reason: failing.length ? failing.map((r) => `${r.project}: ${r.status}\n${r.tail}`).join('\n') : undefined,
    findings: failing.map((r) => ({ source: 'check', ruleId: def.checkId, severity: r.status === 'FAIL' ? 'BLOCKER' : 'WARNING', location: r.project, message: r.tail.split('\n').slice(-8).join('\n'), state: 'open' })),
    command: commandLabel,
    durationMs: Date.now() - startedAt,
    tool: { name: adapter.adapterId, version: adapter.version },
    extensions: { 'x-kit': `@acme/presets@${ctx.kit.version}`, 'x-projects': perProject.map((r) => ({ project: r.project, status: r.status })) },
  });
}

function withTempFile(path, content, fn) {
  writeFileSync(path, content);
  try {
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
}

const notInstalled = (def, adapter, ctx) =>
  checkResult(def, { status: 'ERROR', reason: `kit @acme/presets@${ctx.kit.version} is not installed (run pnpm install in acme-policy)`, tool: { name: adapter.adapterId, version: adapter.version } });

export function lintCheck(def, ctx) {
  const adapter = adapterDef('eslint');
  if (!ctx.kit.installed) return notInstalled(def, adapter, ctx);
  const started = Date.now();
  const eslint = join(ctx.kit.dir, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const runs = entries(ctx).map((p, i) => {
    const cfg = join(workDir(ctx), `eslint.${i}.config.mjs`);
    writeFileSync(cfg, verifyFiles(p.entry, { kitDir: ctx.kit.dir, kitVersion: ctx.kit.version, boundaries: hasNx(ctx.repo) }).eslint);
    return { project: p.name, ...runTool(adapter, process.execPath, [eslint, '--config', cfg, '.'], { cwd: p.abs, env: ctx.env, timeoutSeconds: def.timeoutSeconds }) };
  });
  return result(def, adapter, ctx, runs, started, 'eslint (kit) --config <generated> . per project');
}

export function typecheckCheck(def, ctx) {
  const adapter = adapterDef('tsc');
  if (!ctx.kit.installed) return notInstalled(def, adapter, ctx);
  const started = Date.now();
  const prep = prepare(ctx, def.timeoutSeconds);
  if (prep) return result(def, adapter, ctx, [{ project: '(prepare)', ...prep }], started, 'prepare');
  const tsc = join(ctx.kit.dir, 'node_modules', 'typescript', 'bin', 'tsc');
  const runs = entries(ctx).filter((p) => TYPECHECKED(p.entry.kind)).map((p) => {
    if (p.entry.kind === 'next-app') {
      const typegen = runTool(adapterDef('build'), join(p.abs, 'node_modules', '.bin', 'next'), ['typegen'], { cwd: p.abs, env: ctx.env, timeoutSeconds: def.timeoutSeconds });
      if (typegen.status !== 'PASS') return { project: p.name, status: typegen.status, tail: `next typegen: ${typegen.tail}` };
    }
    const files = verifyFiles(p.entry, { kitDir: ctx.kit.dir, kitVersion: ctx.kit.version, boundaries: false });
    return {
      project: p.name,
      ...withTempFile(join(p.abs, VERIFY_FILES.tsconfig), files.tsconfig, () =>
        runTool(adapter, process.execPath, [tsc, '-p', VERIFY_FILES.tsconfig], { cwd: p.abs, env: ctx.env, timeoutSeconds: def.timeoutSeconds })),
    };
  });
  return result(def, adapter, ctx, runs, started, 'tsc (kit) -p <generated> per project');
}

export function testCheck(def, ctx) {
  const adapter = adapterDef('vitest');
  const started = Date.now();
  const prep = prepare(ctx, def.timeoutSeconds);
  if (prep) return result(def, adapter, ctx, [{ project: '(prepare)', ...prep }], started, 'prepare');
  const runs = entries(ctx)
    .filter((p) => p.entry.test)
    .map((p) => {
      const files = verifyFiles(p.entry, { kitDir: ctx.kit.dir, kitVersion: ctx.kit.version, boundaries: false });
      return {
        project: p.name,
        ...withTempFile(join(p.abs, VERIFY_FILES.vitest), files.vitest, () =>
          runTool(adapter, join(p.abs, 'node_modules', '.bin', 'vitest'), ['run', '--config', VERIFY_FILES.vitest], { cwd: p.abs, env: ctx.env, timeoutSeconds: def.timeoutSeconds })),
      };
    });
  return result(def, adapter, ctx, runs, started, 'vitest (product, pinned) run --config <generated> per project with tests');
}

export function buildCheck(def, ctx) {
  const adapter = adapterDef('build');
  const started = Date.now();
  const prep = prepare(ctx, def.timeoutSeconds);
  if (prep) return result(def, adapter, ctx, [{ project: '(prepare)', ...prep }], started, 'prepare');
  const runs = entries(ctx)
    .filter((p) => p.entry.kind === 'next-app')
    .map((p) => ({ project: p.name, ...runTool(adapter, join(p.abs, 'node_modules', '.bin', 'next'), ['build'], { cwd: p.abs, env: ctx.env, timeoutSeconds: def.timeoutSeconds }) }));
  return result(def, adapter, ctx, runs, started, 'library prepare (nx) + next build (product, pinned) per app');
}

function hasBaselines(dir, platform) {
  const root = join(dir, 'test');
  const found = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (n.isDirectory()) walk(join(d, n.name));
      else if (n.name.endsWith(`-chromium-${platform}.png`)) found.push(n.name);
    }
  };
  walk(root);
  walk(join(dir, 'src'));
  return found.length > 0;
}

/**
 * Real-browser lanes (tech-design 07 §6b; D-21). lane 'interaction' → ds.story-interaction (*.browser.test.*),
 * lane 'visual' → visual.stories (*.visual.test.*). The verifier never updates baselines (FE-TEST-002); a platform
 * without any baseline yet is NOT_ASSESSED (its set is added by a trusted mechanism), never a false PASS.
 */
function browserLane(def, ctx, lane) {
  const adapter = adapterDef('vitest');
  const started = Date.now();
  const projects = entries(ctx).filter((p) => p.entry.test?.browser && (lane === 'interaction' || p.entry.test.browser.visual));
  if (!projects.length) return checkResult(def, { status: 'PASS', reason: undefined, extensions: { 'x-note': 'no project declares this browser lane' } });
  const prep = prepare(ctx, def.timeoutSeconds);
  if (prep) return result(def, adapter, ctx, [{ project: '(prepare)', ...prep }], started, 'prepare');
  const runs = [];
  for (const p of projects) {
    if (lane === 'visual' && !hasBaselines(p.abs, process.platform)) {
      return checkResult(def, { status: 'NOT_ASSESSED', reason: `no visual baselines for platform ${process.platform} in ${p.dir}: they are added by a trusted mechanism, never by the verifier`, tool: { name: adapter.adapterId, version: adapter.version } });
    }
    const files = verifyFiles(p.entry, { kitDir: ctx.kit.dir, kitVersion: ctx.kit.version, boundaries: false });
    runs.push({
      project: p.name,
      ...withTempFile(join(p.abs, VERIFY_FILES.browser), files.browser, () =>
        runTool(adapter, join(p.abs, 'node_modules', '.bin', 'vitest'), ['run', '--config', VERIFY_FILES.browser, lane === 'visual' ? '.visual.test.' : '.browser.test.'], { cwd: p.abs, env: { ...ctx.env, CI: 'true' }, timeoutSeconds: def.timeoutSeconds })),
    });
  }
  return result(def, adapter, ctx, runs, started, `vitest browser (chromium, product-pinned) lane ${lane}`);
}

export const storyInteractionCheck = (def, ctx) => browserLane(def, ctx, 'interaction');
export const visualStoriesCheck = (def, ctx) => browserLane(def, ctx, 'visual');
