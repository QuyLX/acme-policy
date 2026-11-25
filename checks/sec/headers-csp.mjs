// sec.headers-csp — security headers and a nonce-based CSP on every Next.js app (FE §19.1, §3.5 protection, §6.2 not indexed).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkResult } from '../../lib/result.mjs';

const HEADERS = ['Strict-Transport-Security', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy', 'Cross-Origin-Opener-Policy', 'X-Frame-Options', 'X-Robots-Tag'];
const CSP_DIRECTIVES = ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "'nonce-"];
const CONFIG_NAMES = ['next.config.ts', 'next.config.mjs', 'next.config.js'];
const Q = '[\'"`]';
// 'unsafe-eval' is allowed only inside the truthy arm of a dev conditional: `isDev ? "... 'unsafe-eval'" : ...`.
const DEV_ARM = /(?:\bisDev|NODE_ENV\s*===\s*'development')\s*\?\s*(["'`])(?:(?!\1).)*$/;
const CSP_SET = new RegExp(`\\.(?:set|append)\\(\\s*${Q}Content-Security-Policy${Q}|${Q}Content-Security-Policy${Q}\\s*:`);

/** Relative name of the app's Next config (`next.config.{ts,mjs,js}`), or null. */
export function findNextConfig(appDir) {
  return CONFIG_NAMES.find((n) => existsSync(join(appDir, n))) ?? null;
}

/**
 * Blank out `//` and block comments so matching sees code only. Heuristic: a small scanner that tracks '...', "..." and
 * `...` string state (so `https://` in a string survives); regex literals and `${}` nesting in templates are not parsed.
 * Newlines are kept so line numbers stay valid.
 */
export function stripComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === quote || (c === '\n' && quote !== '`')) quote = null;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      i--;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, '');
      i = stop - 1;
    } else {
      if (c === "'" || c === '"' || c === '`') quote = c;
      out += c;
    }
  }
  return out;
}

/** Findings for the text of `src/proxy.ts` (comments are ignored). */
export function proxyTextFindings(raw) {
  const out = [];
  const proxy = stripComments(raw);
  if (!CSP_SET.test(proxy)) out.push({ location: 'src/proxy.ts', message: 'Content-Security-Policy header is not set (no .set(...) call or header object in code)' });
  for (const d of CSP_DIRECTIVES) if (!proxy.includes(d)) out.push({ location: 'src/proxy.ts', message: `CSP lacks ${d}` });
  proxy.split('\n').forEach((line, i) => {
    if (line.includes("'unsafe-inline'")) out.push({ location: `src/proxy.ts:${i + 1}`, message: "CSP allows 'unsafe-inline'" });
    for (let at = line.indexOf("'unsafe-eval'"); at !== -1; at = line.indexOf("'unsafe-eval'", at + 1)) {
      if (!DEV_ARM.test(line.slice(0, at))) { out.push({ location: `src/proxy.ts:${i + 1}`, message: "CSP allows 'unsafe-eval' outside the dev arm of a dev conditional" }); break; }
    }
  });
  return out;
}

export function headersCspFindings(appDir) {
  const out = [];
  const cfgName = findNextConfig(appDir) ?? 'next.config.ts';
  const cfg = stripComments(existsSync(join(appDir, cfgName)) ? readFileSync(join(appDir, cfgName), 'utf8') : '');
  for (const h of HEADERS) if (!new RegExp(`${Q}${h}${Q}`).test(cfg)) out.push({ location: cfgName, message: `missing header ${h} in headers()` });
  const proxyPath = join(appDir, 'src', 'proxy.ts');
  if (!existsSync(proxyPath)) {
    out.push({ location: 'src/proxy.ts', message: 'missing src/proxy.ts: no per-request Content-Security-Policy with a nonce' });
    return out;
  }
  return [...out, ...proxyTextFindings(readFileSync(proxyPath, 'utf8'))];
}

export function headersCspCheck(def, repo, apps) {
  if (!apps.length) return checkResult(def, { status: 'NOT_ASSESSED', reason: 'no Next.js app found (no next.config.{ts,mjs,js}): nothing to check' });
  const findings = apps.flatMap((app) => headersCspFindings(join(repo, app)).map((f) => ({ source: 'check', ruleId: 'sec.headers-csp', severity: 'BLOCKER', location: `${app}/${f.location}`, message: f.message, state: 'open' })));
  return checkResult(def, { status: findings.length ? 'FAIL' : 'PASS', reason: findings.length ? `${findings.length} header/CSP problem(s)` : undefined, findings });
}
