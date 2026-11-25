// export.csv-injection — FE §8.4 `cap:import-export`: "text cells starting with =, +, -, @, tab or CR are neutralized;
// numeric cells are written as numbers". Runs the kit's ESLint rule @acme/csv-safe-export (the same detection a product
// repo gets once the rule is enabled in its lint profile) through ESLint's Linter, on every source file of the repo
// except tests. Static evidence layer.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listFiles } from '../../lib/files.mjs';
import { policyPath } from '../../lib/io.mjs';
import { checkResult } from '../../lib/result.mjs';
import acme from '../../presets/eslint/rules/index.mjs';

export const RULE_ID = '@acme/csv-safe-export';
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

let kitLinter;
/** ESLint and the TypeScript parser from the pinned kit (presets/), loaded on first use. */
function linter() {
  if (kitLinter) return kitLinter;
  const require = createRequire(policyPath('presets', 'package.json'));
  const { Linter } = require('eslint');
  const tseslint = require('typescript-eslint');
  const instance = new Linter({ configType: 'flat' });
  const config = [
    {
      files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
      languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { '@acme': acme },
      rules: { [RULE_ID]: 'error' },
    },
  ];
  kitLinter = { lint: (text, filename) => instance.verify(text, config, { filename }) };
  return kitLinter;
}

/** Lints one source text; returns ESLint messages of the rule plus fatal parse errors. */
export function lintCsv(text, filename) {
  return linter().lint(text, filename);
}

/** Stable identity of a finding for baselines: file + rule + normalized source line + occurrence (no line number). */
export function findingFingerprint(checkId, file, ruleId, snippet, occurrence = 0) {
  return createHash('sha256').update([checkId, file, ruleId, snippet.replace(/\s+/g, ' ').trim(), occurrence].join('\0')).digest('hex').slice(0, 16);
}

export function csvInjectionCheck(def, { repo }) {
  const started = Date.now();
  const findings = [];
  const unparsed = [];
  for (const file of listFiles(repo).filter((f) => SOURCE.test(f) && !TEST.test(f) && !f.endsWith('.d.ts'))) {
    const text = readFileSync(join(repo, file), 'utf8');
    if (!/join\(|text\/csv|`/.test(text)) continue; // nothing the rule can flag
    const lines = text.split('\n');
    const seen = new Map();
    for (const m of lintCsv(text, file)) {
      if (m.fatal) {
        unparsed.push(`${file}:${m.line}: ${m.message}`);
        continue;
      }
      if (m.ruleId !== RULE_ID) continue;
      const snippet = (lines[m.line - 1] ?? '').trim();
      const key = `${file}\0${snippet}`;
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      findings.push({
        source: 'check',
        ruleId: RULE_ID,
        severity: def.severity,
        location: `${file}:${m.line}`,
        message: m.message,
        snippet,
        fingerprint: findingFingerprint(def.checkId, file, RULE_ID, snippet, occurrence),
        state: 'open',
      });
    }
  }
  const durationMs = Date.now() - started;
  if (findings.length) return checkResult(def, { status: 'FAIL', reason: `${findings.length} CSV cell(s) or bod(ies) not built through toCsv / toCsvCell`, findings, durationMs });
  if (unparsed.length) return checkResult(def, { status: 'NOT_ASSESSED', reason: `could not parse: ${unparsed.join('; ')}`, durationMs });
  return checkResult(def, { status: 'PASS', durationMs });
}
