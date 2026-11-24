// ds.bundle-budget — gzip size of a shared package's entry, bundled by the kit's esbuild with React and peer
// dependencies external, stays within `publicApi.budgetKb` (FE §8.4 design-system; raising a budget is loosening).
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { policyPath } from '../../lib/io.mjs';
import { checkResult } from '../../lib/result.mjs';

const esbuild = createRequire(import.meta.url)(policyPath('presets', 'node_modules', 'esbuild'));

export function bundleSize(dir, entry) {
  const projectDir = resolve(dir);
  const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'));
  const external = ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', ...Object.keys(pkg.peerDependencies ?? {})];
  const out = esbuild.buildSync({
    entryPoints: [join(projectDir, entry)], absWorkingDir: projectDir, bundle: true, minify: true, write: false, format: 'esm',
    platform: 'browser', jsx: 'automatic', external, logLevel: 'silent', loader: { '.css': 'empty' },
  });
  const code = out.outputFiles[0].contents;
  return { minBytes: code.length, gzipBytes: gzipSync(code).length };
}

export function bundleBudgetCheck(def, ctx) {
  const findings = [];
  const sizes = {};
  for (const p of ctx.projects) {
    const api = ctx.config?.projects[p.name]?.publicApi;
    if (!api?.budgetKb || !existsSync(join(p.abs, api.entry))) continue;
    try {
      const s = bundleSize(p.abs, api.entry);
      sizes[p.name] = { ...s, budgetKb: api.budgetKb };
      if (s.gzipBytes > api.budgetKb * 1024) findings.push({ location: p.dir, message: `${(s.gzipBytes / 1024).toFixed(1)} kB gzip > budget ${api.budgetKb} kB` });
    } catch (err) {
      return checkResult(def, { status: 'FAIL', reason: `could not bundle ${p.name}: ${err.message.split('\n')[0]}` });
    }
  }
  return checkResult(def, {
    status: findings.length ? 'FAIL' : 'PASS',
    findings: findings.map((f) => ({ source: 'check', ruleId: def.checkId, severity: 'BLOCKER', state: 'open', ...f })),
    extensions: { 'x-sizes': sizes },
  });
}
