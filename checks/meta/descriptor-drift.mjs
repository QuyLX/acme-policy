// meta.descriptor-drift — descriptors match the repository (CORE-KNW-04; FE §7.2, DV-02: one factory.yaml per app).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validate } from '../../lib/schema.mjs';
import { listFiles } from '../../lib/files.mjs';
import { matchesAny } from '../../lib/glob.mjs';
import { checkResult } from '../../lib/result.mjs';

export function descriptorProblems(repo) {
  const problems = [];
  const appsDir = join(repo, 'apps');
  const apps = existsSync(appsDir) ? readdirSync(appsDir).filter((d) => existsSync(join(appsDir, d, 'package.json'))) : [];
  let files = null;
  for (const app of apps) {
    const rel = `apps/${app}/factory.yaml`;
    if (!existsSync(join(repo, rel))) {
      problems.push({ location: rel, message: 'app has no descriptor (FE §7.2, DV-02)' });
      continue;
    }
    const d = parseYaml(readFileSync(join(repo, rel), 'utf8'));
    for (const e of validate('factory-config', d)) problems.push({ location: rel, message: `schema: ${e}` });
    if (d?.application !== app) problems.push({ location: rel, message: `application "${d?.application}" ≠ folder "${app}"` });
    const backups = (d?.backupOwners ?? []).filter((o) => o !== d?.owner);
    if (!d?.owner || !backups.length) problems.push({ location: rel, message: 'owner and a distinct backup owner are required (CORE-KNW-03)' });
    for (const entry of d?.riskMap ?? []) {
      for (const p of entry.paths) {
        if (!p.startsWith(`apps/${app}/`) && !p.startsWith('packages/')) problems.push({ location: rel, message: `riskMap path "${p}" is outside apps/${app}/ and packages/` });
      }
    }
    for (const asset of d?.promptAssets ?? []) {
      files ??= listFiles(repo);
      if (!files.some((f) => matchesAny(f, [asset]))) problems.push({ location: rel, message: `promptAssets "${asset}" matches no file` });
    }
  }
  return problems;
}

export function descriptorDriftCheck(def, repo) {
  const problems = descriptorProblems(repo);
  return checkResult(def, {
    status: problems.length ? 'FAIL' : 'PASS',
    reason: problems.length ? `${problems.length} descriptor drift problem(s)` : undefined,
    findings: problems.map((p) => ({ source: 'check', ruleId: def.checkId, severity: 'BLOCKER', state: 'open', ...p })),
  });
}
