// meta.toolchain-pin — tools that run from the product install (vitest, next, nx) must be exactly the versions the
// policy repo pins (registry/kits.yaml), so a PR cannot change its verifier by bumping a dependency.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverProjects } from '../../lib/workspace.mjs';
import { readProjectConfig } from '../../lib/kit.mjs';
import { checkResult } from '../../lib/result.mjs';

function installedVersion(dir, pkg) {
  const p = join(dir, 'node_modules', pkg, 'package.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).version : null;
}

export function toolchainPinCheck(def, repo, kit) {
  const started = Date.now();
  const { config, errors } = readProjectConfig(repo);
  const findings = [];
  const missing = [];
  const need = [];
  if (existsSync(join(repo, 'nx.json'))) need.push({ dir: repo, where: '.', pkg: 'nx' });
  for (const p of config ? discoverProjects(repo) : []) {
    const entry = config.projects[p.name];
    if (!entry) continue;
    if (entry.kind === 'next-app') need.push({ dir: p.abs, where: p.dir, pkg: 'next' });
    if (entry.test) need.push({ dir: p.abs, where: p.dir, pkg: 'vitest' });
    if (entry.test?.browser) for (const pkg of ['@vitest/browser-playwright', 'playwright']) need.push({ dir: p.abs, where: p.dir, pkg });
  }
  for (const { dir, where, pkg } of need) {
    const want = kit.productTools[pkg];
    const have = installedVersion(dir, pkg);
    if (have === null) missing.push(`${where}: ${pkg}`);
    else if (have !== want) findings.push({ source: 'check', ruleId: 'meta.toolchain-pin', severity: 'BLOCKER', location: `${where}/node_modules/${pkg}`, message: `${pkg}@${have} ≠ pinned ${want} (registry/kits.yaml)`, state: 'open' });
  }
  const rootPkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const declared = rootPkg.devDependencies?.['@acme/presets'] ?? rootPkg.dependencies?.['@acme/presets'];
  if (!declared) findings.push({ source: 'check', ruleId: 'meta.toolchain-pin', severity: 'WARNING', location: 'package.json', message: '@acme/presets is not a dependency: editors and local runs cannot load the generated configs', state: 'open' });

  const failing = findings.filter((f) => f.severity === 'BLOCKER');
  let status = failing.length ? 'FAIL' : 'PASS';
  let reason = failing.length ? `${failing.length} tool version(s) differ from the pins` : undefined;
  if (!config) { status = 'FAIL'; reason = errors.join('; '); }
  else if (missing.length && !failing.length) { status = 'ERROR'; reason = `not installed (environment, run pnpm install): ${missing.join(', ')}`; }
  return checkResult(def, { status, reason, findings, durationMs: Date.now() - started });
}
