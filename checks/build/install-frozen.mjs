// build.install-frozen — installs follow the lockfile only, and the lockfile is linted for integrity and registry
// (FE §19.2). Uses the package manager in lockfile-only, offline mode: nothing is installed or downloaded.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lockfilePackages } from '../../lib/lockfile.mjs';
import { checkResult } from '../../lib/result.mjs';

/** Lockfile lint: every registry package has an integrity hash; tarball URLs only from allowed hosts. */
export function lintLockfile(text, allowedHosts) {
  const problems = [];
  for (const [key, entry] of Object.entries(lockfilePackages(text))) {
    const res = entry?.resolution ?? {};
    if (res.tarball) {
      let host = null;
      try {
        host = new URL(res.tarball).host;
      } catch {
        /* relative or file: tarball */
      }
      if (host && !allowedHosts.includes(host)) problems.push(`${key}: tarball from ${host} (allowed: ${allowedHosts.join(', ')})`);
    }
    if (!res.integrity && !res.directory && !res.repo && !(res.tarball ?? '').startsWith('file:')) problems.push(`${key}: no integrity hash`);
  }
  return problems;
}

export function installFrozenCheck(def, { repo, allowedHosts, timeoutSeconds }) {
  const started = Date.now();
  const lockPath = join(repo, 'pnpm-lock.yaml');
  if (!existsSync(lockPath)) return checkResult(def, { status: 'FAIL', reason: 'pnpm-lock.yaml is missing: installs must follow a lockfile', durationMs: Date.now() - started });
  const findings = lintLockfile(readFileSync(lockPath, 'utf8'), allowedHosts).map((m) => ({ source: 'check', ruleId: def.checkId, severity: 'BLOCKER', location: 'pnpm-lock.yaml', message: m, state: 'open' }));
  const r = spawnSync('pnpm', ['install', '--frozen-lockfile', '--lockfile-only', '--offline', '--ignore-scripts'], { cwd: repo, encoding: 'utf8', timeout: timeoutSeconds * 1000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  let status = findings.length ? 'FAIL' : 'PASS';
  let reason = findings.length ? `${findings.length} lockfile problem(s)` : undefined;
  if (r.error || r.status === null) {
    status = 'ERROR';
    reason = `could not run pnpm: ${r.error?.message ?? r.signal}`;
  } else if (r.status !== 0) {
    const outdated = /OUTDATED_LOCKFILE|not up to date|lockfile needs to be updated|frozen-lockfile/i.test(out);
    status = outdated ? 'FAIL' : 'ERROR';
    reason = outdated ? 'pnpm-lock.yaml is not in sync with the manifests' : `pnpm exited ${r.status} (environment): ${out.trim().split('\n').slice(-3).join(' ')}`;
  }
  return checkResult(def, { status, reason, findings, durationMs: Date.now() - started });
}
