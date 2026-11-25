// sec.headers-csp — security headers and a nonce-based CSP on every Next.js app (FE §19.1, §3.5 protection, §6.2 not indexed).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkResult } from '../../lib/result.mjs';

const HEADERS = ['Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'Cross-Origin-Opener-Policy', 'X-Frame-Options', 'X-Robots-Tag'];
const CSP_DIRECTIVES = ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "'nonce-"];

export function headersCspFindings(appDir) {
  const out = [];
  const cfgPath = join(appDir, 'next.config.ts');
  const cfg = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  for (const h of HEADERS) if (!cfg.includes(`'${h}'`)) out.push({ location: 'next.config.ts', message: `missing header ${h} in headers()` });
  const proxyPath = join(appDir, 'src', 'proxy.ts');
  if (!existsSync(proxyPath)) {
    out.push({ location: 'src/proxy.ts', message: 'missing src/proxy.ts: no per-request Content-Security-Policy with a nonce' });
    return out;
  }
  const proxy = readFileSync(proxyPath, 'utf8');
  if (!proxy.includes('Content-Security-Policy')) out.push({ location: 'src/proxy.ts', message: 'Content-Security-Policy header is not set' });
  for (const d of CSP_DIRECTIVES) if (!proxy.includes(d)) out.push({ location: 'src/proxy.ts', message: `CSP lacks ${d}` });
  proxy.split('\n').forEach((line, i) => {
    if (line.includes("'unsafe-inline'")) out.push({ location: `src/proxy.ts:${i + 1}`, message: "CSP allows 'unsafe-inline'" });
    if (line.includes("'unsafe-eval'") && !/isDev\s*\?|NODE_ENV\s*===\s*'development'/.test(line)) out.push({ location: `src/proxy.ts:${i + 1}`, message: "CSP allows 'unsafe-eval' outside development" });
  });
  return out;
}

export function headersCspCheck(def, repo, apps) {
  const findings = apps.flatMap((app) => headersCspFindings(join(repo, app)).map((f) => ({ source: 'check', ruleId: 'sec.headers-csp', severity: 'BLOCKER', location: `${app}/${f.location}`, message: f.message, state: 'open' })));
  return checkResult(def, { status: findings.length ? 'FAIL' : 'PASS', reason: findings.length ? `${findings.length} header/CSP problem(s)` : undefined, findings });
}
