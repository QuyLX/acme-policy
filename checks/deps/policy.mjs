// deps.policy — FE-DEP-001; CORE-DEP-02 (vulnerability SLA), CORE-DEP-03 (license allowlist on every manifest or
// lockfile change). Licenses come from the installed packages; advisories from the package manager's audit.
// Only advisories on packages the change introduces or changes block the merge; pre-existing ones are reported with
// their remediation SLA (they block release when overdue, which is a gardening/release concern).
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkResult } from '../../lib/result.mjs';
import { matchesAny } from '../../lib/glob.mjs';

export function installedPackages(repo) {
  const store = join(repo, 'node_modules', '.pnpm');
  if (!existsSync(store)) return null;
  const out = [];
  for (const entry of readdirSync(store)) {
    const nm = join(store, entry, 'node_modules');
    if (!existsSync(nm) || !lstatSync(nm).isDirectory()) continue;
    for (const name of readdirSync(nm)) {
      const dirs = name.startsWith('@') ? readdirSync(join(nm, name)).map((n) => join(name, n)) : [name];
      for (const d of dirs) {
        const full = join(nm, d);
        if (lstatSync(full).isSymbolicLink()) continue;
        const pj = join(full, 'package.json');
        if (!existsSync(pj)) continue;
        const pkg = JSON.parse(readFileSync(pj, 'utf8'));
        const lic = pkg.license ?? pkg.licenses;
        out.push({ name: pkg.name ?? d, version: pkg.version, license: typeof lic === 'string' ? lic : Array.isArray(lic) ? lic.map((l) => l.type ?? l).join(' OR ') : lic?.type ?? null });
      }
    }
  }
  return out;
}

/** SPDX expression check (OR: any allowed; AND/WITH: all allowed). */
export function licenseAllowed(expr, allow) {
  if (!expr) return false;
  const clean = expr.replace(/[()]/g, ' ').trim();
  if (/\sOR\s/.test(clean)) return clean.split(/\s+OR\s+/).some((p) => licenseAllowed(p, allow));
  return clean.split(/\s+(?:AND|WITH)\s+/).every((p) => allow.includes(p.trim()));
}

export function audit(repo, timeoutSeconds) {
  const r = spawnSync('pnpm', ['audit', '--json'], { cwd: repo, encoding: 'utf8', timeout: timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024 });
  try {
    const json = JSON.parse(r.stdout);
    return Object.values(json.advisories ?? {}).map((a) => ({ id: a.id ?? a.github_advisory_id, module: a.module_name, severity: a.severity, title: a.title, versions: [...new Set(a.findings.map((f) => f.version))] }));
  } catch {
    return null; // registry unreachable or unexpected output → that part is NOT_ASSESSED
  }
}

/** Pure evaluation. `isNew(name, version)` tells whether the change introduced or changed that package. */
export function evaluateDeps({ packages, advisories, policy, isNew }) {
  const findings = [];
  let fail = false;
  for (const p of packages) {
    if (licenseAllowed(p.license, policy.licenses.allow)) continue;
    if (policy.licenses.reviewed.some((r) => matchesAny(p.name, [r.name]) && r.license === p.license)) continue;
    fail = true;
    findings.push({ severity: 'BLOCKER', location: `${p.name}@${p.version}`, message: `License ${p.license ?? 'unknown'} is not on the allowlist (unknown = restricted)` });
  }
  for (const a of advisories ?? []) {
    const fresh = a.versions.some((v) => isNew(a.module, v));
    const blocks = fresh && policy.advisories.blockAtMerge.includes(a.severity);
    if (blocks) fail = true;
    const days = policy.advisories.remediationDays[a.severity];
    findings.push({
      severity: blocks ? 'BLOCKER' : a.severity === 'high' || a.severity === 'critical' ? 'WARNING' : 'INFO',
      location: `${a.module}@${a.versions.join(',')}`,
      message: `${a.severity} advisory ${a.id}: ${a.title}. ${fresh ? 'Introduced by this change' : 'Pre-existing'}; remediate within ${days} days (CORE-DEP-02)`,
    });
  }
  return { fail, findings };
}

export function depsPolicyCheck(def, { repo, policy, changed, isNew, timeoutSeconds }) {
  const started = Date.now();
  const touchesDeps = changed.some((p) => p.endsWith('package.json') || p.endsWith('pnpm-lock.yaml'));
  if (!touchesDeps) return checkResult(def, { status: 'PASS', reason: undefined, findings: [], durationMs: Date.now() - started, extensions: { 'x-note': 'no manifest or lockfile change' } });
  const packages = installedPackages(repo);
  if (!packages) return checkResult(def, { status: 'ERROR', reason: 'dependencies are not installed (environment): run pnpm install', durationMs: Date.now() - started });
  const advisories = audit(repo, timeoutSeconds);
  const { fail, findings } = evaluateDeps({ packages, advisories, policy, isNew });
  const status = fail ? 'FAIL' : advisories === null ? 'NOT_ASSESSED' : 'PASS';
  return checkResult(def, {
    status,
    reason: fail ? 'dependency policy violated' : advisories === null ? 'vulnerability audit unavailable (registry unreachable): license part passed' : undefined,
    findings: findings.map((f) => ({ source: 'check', ruleId: 'FE-DEP-001', state: 'open', ...f })),
    durationMs: Date.now() - started,
    extensions: { 'x-packages-scanned': packages.length, 'x-advisories': advisories?.length ?? null },
  });
}
