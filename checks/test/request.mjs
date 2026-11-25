// Shared input of test.plan and test.e2e-journeys: a run request (YAML/JSON, ctx.input) naming the primary repo, the
// portfolio index, the environment manifest, the environment's live health probe and the risk sub-tier.
//   environment  EnvironmentManifest: what the run is checked against (digest) plus the health recorded before the run
//   healthProbe  the environment's health document (EnvironmentManifest shape), re-read on every probe: the stand-in for
//                `factory env status --json` (FE §8.8). Required with a non-mock environment: without it a failure
//                observed while the environment is down could not be told apart from a product failure.
// Two modes:
//   - pipeline (`acme-policy run --repo <dir> --input <request>`): the repo under verification is ctx.repo, already
//     installed by the pipeline; changed files come from the pipeline (ctx.changed).
//   - fixture (registry `{ input }` fixture, no ctx.repo): `repo` + `change` are copied to a temp git work tree, the change
//     is applied uncommitted, and workspace packages are linked into node_modules (what `pnpm install` does for
//     `workspace:*` dependencies), so tests can run for real.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { readJson, readYaml, policyPath } from '../../lib/io.mjs';
import { validate } from '../../lib/schema.mjs';
import { discoverProjects } from '../../lib/workspace.mjs';
import { digestOf, planTests } from '../../lib/test-planner.mjs';

const GIT = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false'];
function git(cwd, args) {
  const r = spawnSync('git', [...GIT, ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// Request paths are absolute or relative to the policy repo root (like every registry fixture path).
const at = (_base, p) => (isAbsolute(p) ? p : policyPath(p));
const readAny = (p) => (p.endsWith('.json') ? readJson(p) : readYaml(p));

export function loadRequest(input) {
  const request = readAny(input);
  const portfolioPath = request.portfolio && at(dirname(input), request.portfolio);
  const portfolio = portfolioPath ? readJson(portfolioPath) : undefined;
  const repoRoots = {};
  for (const r of portfolio?.repos ?? []) repoRoots[r.id] = resolve(dirname(portfolioPath), r.path);
  for (const [id, p] of Object.entries(request.repos ?? {})) repoRoots[id] = at(dirname(input), p);
  const manifest = request.environment ? readJson(at(dirname(input), request.environment)) : undefined;
  return { request, portfolio, repoRoots, manifest };
}

/** Links every workspace project into <root>/node_modules (idempotent; never overwrites an existing entry). */
export function linkWorkspace(root) {
  for (const p of discoverProjects(root)) {
    const link = join(root, 'node_modules', ...p.name.split('/'));
    if (existsSync(link)) continue;
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(p.abs, link, 'dir');
  }
}

/** A temp git work tree of `repo` with `change` applied uncommitted; returns { root, changed, cleanup }. */
export function prepareCopy(repo, change) {
  const tmp = mkdtempSync(join(tmpdir(), 'acme-plan-'));
  const root = join(tmp, 'repo');
  cpSync(repo, root, { recursive: true });
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  if (change) git(root, ['apply', change]);
  const changed = [...new Set([...git(root, ['diff', '--name-only', 'HEAD']).split('\n'), ...git(root, ['ls-files', '--others', '--exclude-standard']).split('\n')].filter(Boolean))];
  writeFileSync(join(root, '.git', 'info', 'exclude'), 'node_modules/\n'); // links are install output, not a change
  linkWorkspace(root);
  return { root, changed, cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

/** The environment manifest digest covers what the run was checked against (FE §8.8), not the health probe. */
export function manifestDigest(m) {
  return digestOf({
    environment: m.environment,
    services: m.services.map((s) => ({ name: s.name, version: s.version })),
    dataSeed: { id: m.dataSeed.id, version: m.dataSeed.version },
    flags: m.flags,
  });
}

/** Pre-run health (`factory env status`, FE §8.8): unhealthy environment → environment; seed not ready → test-data. */
export function environmentHealth(m) {
  const down = [...m.services, ...(m.auxiliary ?? [])].filter((s) => s.health === 'unhealthy');
  if (down.length) return { ok: false, attribution: 'environment', detail: down.map((s) => `${s.name} ${s.health}${s.detail ? ` (${s.detail})` : ''}`).join('; ') };
  if (m.dataSeed.status !== 'ready') return { ok: false, attribution: 'test-data', detail: `data seed ${m.dataSeed.id}@${m.dataSeed.version} is ${m.dataSeed.status}` };
  return { ok: true };
}

/**
 * One live health probe: reads the environment's health document now. An unreadable or invalid document means the
 * environment cannot report its health: unhealthy, attribution environment.
 * @returns {{ ok: boolean, attribution?: 'environment'|'test-data', detail?: string, at: string }}
 */
export function probeHealth(path) {
  const at = new Date().toISOString();
  let doc;
  try {
    doc = readJson(path);
  } catch (err) {
    return { ok: false, attribution: 'environment', detail: `health probe unavailable: ${err.message}`, at };
  }
  const errors = validate('environment-manifest', doc);
  if (errors.length) return { ok: false, attribution: 'environment', detail: `health probe answer invalid: ${errors.join('; ')}`, at };
  return { ...environmentHealth(doc), at };
}

/**
 * Resolves the request into a planned workspace. Throws on invalid input (the caller reports ERROR, attribution harness).
 * @returns {{ plan, root, primary, manifest?, environment?, healthProbe?, request, cleanup }}
 */
export function planFromRequest(ctx) {
  const { request, portfolio, repoRoots, manifest } = loadRequest(ctx.input);
  if (manifest) {
    const errors = validate('environment-manifest', manifest);
    if (errors.length) throw new Error(`environment manifest invalid: ${errors.join('; ')}`);
  }
  const primary = request.primary;
  if (!primary) throw new Error('run request: `primary` (repo id) is required');
  const healthProbe = request.healthProbe && at(dirname(ctx.input), request.healthProbe);
  if (manifest && manifest.environment.kind !== 'mock' && !healthProbe) throw new Error(`run request: environment ${manifest.environment.id} (${manifest.environment.kind}) needs \`healthProbe\` (the environment's live health document, FE §8.8)`);
  let ws;
  if (ctx.repo) ws = { root: ctx.repo, changed: ctx.changed ?? [], cleanup: () => {} };
  else {
    if (!request.repo) throw new Error('run request: `repo` is required without a pipeline repo');
    ws = prepareCopy(at(dirname(ctx.input), request.repo), request.change && at(dirname(ctx.input), request.change));
  }
  try {
    const plan = planTests({
      repos: { ...repoRoots, [primary]: ws.root },
      primary,
      changed: ws.changed,
      portfolio,
      tier: request.tier ?? 'R1',
      config: { sharedAssetGlobs: request.sharedAssetGlobs ?? ['packages/**'] },
      include: request.include ?? [],
      environment: manifest?.environment,
    });
    const environment = manifest && { ...manifest.environment, manifestDigest: manifestDigest(manifest) };
    return { plan, root: ws.root, primary, manifest, environment, healthProbe, request, cleanup: ws.cleanup };
  } catch (err) {
    ws.cleanup();
    throw err;
  }
}
