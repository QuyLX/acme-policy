// Static authorization checks over the permission matrix (`permissions.yaml` per app; schemas/permission-matrix).
//   authz.permission-matrix — FE-PERM-001 ("frontend permissions only reflect backend authorization, never replace it")
//                             and FE-NEXT-003 (authorization in the server-side data access layer).
//   authz.negative          — FE-PERM-001 ("every permission-sensitive action has … a negative test"), FE-NEXT-003.
// No IdP (D-03 open): the matrix `roles` is the IAM stand-in and tests use a SessionProvider test double. A `deny`
// persona such as `noAccess` is a valid session without the permission (forbidden), not a missing session.
// Detection is lexical (comments stripped, string literals kept), over the app's own files and relative imports.
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { listFiles } from '../../lib/files.mjs';
import { checkResult } from '../../lib/result.mjs';
import { validate } from '../../lib/schema.mjs';

const SOURCE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const USE_CLIENT = /^\s*(?:(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/)\s*)*['"]use client['"]/;
// Server-side guards: a call that decides on a literal permission string with the request context.
const SERVER_GUARD = /\b(?:can|requirePermission|assertPermission|hasPermission)\s*\(\s*[A-Za-z_$][\w$.]*\s*,\s*(['"`])([\w.:-]+)\1/g;
// Client-side gates: the same helpers or hooks, with or without a subject argument.
const CLIENT_GATE = /\b(?:can|hasPermission|usePermission|requirePermission)\s*\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?(['"`])([\w.:-]+)\1/g;
// `authorize` that returns the literal true whatever the request (arrow, async arrow, method, function).
const TRIVIAL_AUTHORIZE = [
  /\bauthorize\s*:\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\(?\s*(?:true|!0)\b/,
  /\bauthorize\s*:\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*return\s+(?:true|!0)\s*;?\s*\}/,
  /\bauthorize\s*:\s*(?:async\s+)?function\s*[\w$]*\s*\([^)]*\)\s*\{\s*return\s+(?:true|!0)\s*;?\s*\}/,
  /\b(?:async\s+)?authorize\s*\([^)]*\)\s*\{\s*return\s+(?:true|!0)\s*;?\s*\}/,
];
const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/g;
const EXTS = ['', '.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];

/** Removes comments, keeps strings and template literals (a URL inside a string is not a comment). */
export function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const block = text.slice(i, end < 0 ? text.length : end + 2);
      out += block.replace(/[^\n]/g, ' ');
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out;
}

/** Every `permissions.yaml` in the repo, parsed and validated. */
export function loadMatrices(repo) {
  return listFiles(repo)
    .filter((f) => f === 'permissions.yaml' || f.endsWith('/permissions.yaml'))
    .map((file) => {
      let matrix;
      try {
        matrix = parseYaml(readFileSync(join(repo, file), 'utf8'));
      } catch (err) {
        return { file, dir: dirname(file), matrix: null, errors: [`not YAML: ${err.message}`] };
      }
      return { file, dir: dirname(file), matrix, errors: validate('permission-matrix', matrix) };
    });
}

/** Source files of one app: text without comments, client/test classification and the relative import graph. */
export function appSources(repo, dir) {
  const files = listFiles(join(repo, dir)).filter((f) => SOURCE.test(f) && !f.endsWith('.d.ts'));
  const set = new Set(files);
  const byFile = new Map();
  for (const f of files) {
    const raw = readFileSync(join(repo, dir, f), 'utf8');
    const text = stripComments(raw);
    const imports = [];
    for (const m of text.matchAll(IMPORT)) {
      const base = normalize(join(dirname(f), m[1]));
      const hit = EXTS.map((e) => base + e).find((cand) => set.has(cand));
      if (hit) imports.push(hit);
    }
    byFile.set(f, { file: f, text, client: USE_CLIENT.test(raw), test: TEST.test(f), imports });
  }
  return byFile;
}

const permissionsIn = (text, re) => [...text.matchAll(re)].map((m) => m[2]);
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/** Server files reachable from the entry through relative imports (client and test files excluded). */
function serverReach(sources, entry) {
  const out = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    const s = sources.get(f);
    if (!s || out.has(f) || s.client || s.test) continue;
    out.add(f);
    stack.push(...s.imports);
  }
  return out;
}

function finding(def, ruleId, location, message) {
  return { source: 'check', ruleId, severity: def.severity, location, message, state: 'open' };
}

function result(def, findings, started, what) {
  return checkResult(def, {
    status: findings.length ? 'FAIL' : 'PASS',
    reason: findings.length ? `${findings.length} ${what}` : undefined,
    findings,
    durationMs: Date.now() - started,
  });
}

function noMatrix(def, started) {
  return checkResult(def, { status: 'NOT_ASSESSED', reason: 'no permissions.yaml in the repository: the permission matrix is the input of this check (FE-PERM-001)', durationMs: Date.now() - started });
}

/** Problems of the matrix itself: unknown personas, allow without the permission, deny with it. */
function matrixProblems(def, m) {
  const out = [];
  const roles = m.matrix.roles;
  for (const e of m.matrix.entries) {
    for (const p of [...e.allow, ...e.deny]) if (!roles[p]) out.push(finding(def, 'authz.matrix-inconsistent', m.file, `${e.id}: persona ${p} is not in roles`));
    for (const p of e.allow) if (roles[p] && !roles[p].includes(e.permission)) out.push(finding(def, 'authz.matrix-inconsistent', m.file, `${e.id}: allowed persona ${p} lacks ${e.permission}`));
    for (const p of e.deny) if (roles[p]?.includes(e.permission)) out.push(finding(def, 'authz.matrix-inconsistent', m.file, `${e.id}: denied persona ${p} holds ${e.permission}`));
  }
  return out;
}

/** authz.permission-matrix — FE-PERM-001, FE-NEXT-003. */
export function permissionMatrixCheck(def, { repo }) {
  const started = Date.now();
  const matrices = loadMatrices(repo);
  if (!matrices.length) return noMatrix(def, started);
  const findings = [];
  for (const m of matrices) {
    if (m.errors.length) {
      findings.push(finding(def, 'authz.matrix-invalid', m.file, `permission matrix invalid: ${m.errors.join('; ')}`));
      continue;
    }
    findings.push(...matrixProblems(def, m));
    const sources = appSources(repo, m.dir);
    const at = (f, index) => `${join(m.dir, f)}${index === undefined ? '' : `:${lineOf(sources.get(f).text, index)}`}`;
    for (const e of m.matrix.entries) {
      const entry = normalize(e.path);
      const src = sources.get(entry);
      if (!src) {
        findings.push(finding(def, 'authz.entry-missing', join(m.dir, e.path), `${e.id}: ${e.kind} entry ${e.path} does not exist`));
        continue;
      }
      if (src.client) {
        findings.push(finding(def, 'authz.server-guard-missing', at(entry), `${e.id}: the ${e.kind} entry is a 'use client' module; ${e.permission} must be enforced on the server (FE-PERM-001)`));
        continue;
      }
      for (const re of TRIVIAL_AUTHORIZE) {
        const hit = re.exec(src.text);
        if (hit) findings.push(finding(def, 'authz.authorize-trivial', at(entry, hit.index), `${e.id}: authorize always returns true — the server grants ${e.permission} to every signed-in persona (FE-PERM-001, FE-NEXT-003)`));
      }
      const guarded = [...serverReach(sources, entry)].some((f) => permissionsIn(sources.get(f).text, SERVER_GUARD).includes(e.permission));
      if (!guarded) findings.push(finding(def, 'authz.server-guard-missing', at(entry), `${e.id}: no server-side guard for ${e.permission} in the ${e.kind} or the server modules it imports (authorize / requirePermission / can with '${e.permission}')`));
    }
    // A permission that gates the UI but is enforced by no server module (FE-PERM-001: reflect, never replace).
    const serverGuarded = new Set([...sources.values()].filter((s) => !s.client && !s.test).flatMap((s) => permissionsIn(s.text, SERVER_GUARD)));
    const matrixPermissions = new Set(m.matrix.entries.map((e) => e.permission));
    for (const s of [...sources.values()].filter((x) => x.client && !x.test)) {
      const used = new Map();
      for (const match of s.text.matchAll(CLIENT_GATE)) if (!used.has(match[2])) used.set(match[2], match.index);
      for (const p of matrixPermissions) {
        const i = s.text.search(new RegExp(`(['"\`])${p.replace(/[.]/g, '\\.')}\\1`));
        if (i >= 0 && !used.has(p)) used.set(p, i);
      }
      for (const [p, index] of used) {
        if (!serverGuarded.has(p)) findings.push(finding(def, 'authz.client-only-permission', at(s.file, index), `${p} gates the UI in a 'use client' module but no server module enforces it (FE-PERM-001)`));
      }
    }
  }
  return result(def, findings, started, 'authorization finding(s) against the permission matrix');
}

const TEST_CALL = /\b(?:test|it)(?:\.(?:only|skip|todo))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const FORBIDDEN = /forbidden|ForbiddenError|\b403\b/;

/** Test cases of the app: title and body (text up to the next test call). */
function testCases(sources) {
  const out = [];
  for (const s of sources.values()) {
    if (!s.test) continue;
    const calls = [...s.text.matchAll(TEST_CALL)];
    calls.forEach((m, i) => out.push({ file: s.file, title: m[2], body: s.text.slice(m.index + m[0].length, calls[i + 1]?.index ?? s.text.length) }));
  }
  return out;
}

/** authz.negative — FE-PERM-001, FE-NEXT-003: every deny persona of every entry has a tagged negative test. */
export function negativeCheck(def, { repo }) {
  const started = Date.now();
  const matrices = loadMatrices(repo);
  if (!matrices.length) return noMatrix(def, started);
  const findings = [];
  for (const m of matrices) {
    if (m.errors.length) {
      findings.push(finding(def, 'authz.matrix-invalid', m.file, `permission matrix invalid: ${m.errors.join('; ')}`));
      continue;
    }
    const cases = testCases(appSources(repo, m.dir));
    for (const e of m.matrix.entries) {
      if (!e.deny.length) {
        findings.push(finding(def, 'authz.negative-missing', m.file, `${e.id}: no deny persona, so no negative test is required for ${e.permission} — list at least one (FE-PERM-001)`));
        continue;
      }
      for (const p of e.deny) {
        const tagged = cases.filter((c) => c.title.includes(`@authz:${e.id}`) && new RegExp(`@persona:${p}(?![\\w-])`).test(c.title));
        if (!tagged.length) {
          findings.push(finding(def, 'authz.negative-missing', m.file, `${e.id}: no negative test tagged "@authz:${e.id} @persona:${p}"`));
          continue;
        }
        const real = tagged.find((c) => new RegExp(`(['"\`])${p}\\1`).test(c.body) && FORBIDDEN.test(c.body));
        if (!real) findings.push(finding(def, 'authz.negative-vacuous', join(m.dir, tagged[0].file), `${e.id}: the test tagged for ${p} must sign in as '${p}' and assert a forbidden outcome (forbidden / ForbiddenError / 403)`));
      }
    }
  }
  return result(def, findings, started, 'missing or vacuous negative authorization test(s)');
}
