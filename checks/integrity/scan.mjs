// Integrity sensors (Standard §7.13; FE §8.6). One pass over the unified diff produces hits keyed by the Standard's
// stable check IDs (item 38); sensors.mjs turns them into one CheckResult per check.
// Detectors work on added/removed lines. Where the content of a file at base and head is available (readFile), the
// control-file sensor classifies package.json by field (items 5-7); without it, it is conservative (whole file).
import { parseUnifiedDiff } from '../../lib/diff.mjs';
import { matchesAny } from '../../lib/glob.mjs';

const SKIP_FOCUS = /\b(?:it|test|describe|suite|context)\.(?:skip|only|todo|fixme)\s*\(|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|tags\s*:\s*\[[^\]]*['"]!test['"]/;
const PASS_WITH_NO_TESTS = /passWithNoTests/;
const SUPPRESSION = /eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|istanbul ignore|c8 ignore|v8 ignore|biome-ignore|\bas any\b|\bas unknown as\b/;
const LICENSE_COMMENT = /(?:\/\/|\/\*|\*|#).*\b(?:workaround|hack|temporary fix|quick fix|todo:?\s*remove|fixme)\b/i;
const ASSERTION = /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(|\.(?:toBe|toEqual|toStrictEqual|toMatch|toMatchObject|toHaveLength|toContain|toHaveBeenCalled\w*|toThrow|toBeVisible|toHaveText|toBeTruthy|toBeFalsy|toBeNull|toBeDefined)\s*\(/;
const TEST_CASE = /\b(?:it|test)(?:\.(?:skip|only|todo|fixme|each|concurrent))?\s*\(/;
const THRESHOLD = /threshold|coverage\s*[:=]|minimumCoverage|max-?warnings|failOnWarnings|bail\s*[:=]/i;
const ALWAYS_TRUE = /expect\(\s*(true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")\s*\)\s*\.\s*(?:toBe|toEqual|toStrictEqual)\(\s*\1\s*\)|expect\(\s*true\s*\)\s*\.\s*toBeTruthy\(\s*\)/;
const EARLY_RETURN = /^\s*return\s*;?\s*$/;
const MOCK_CALL = /\b(?:vi|jest)\.(?:mock|doMock)\(\s*['"]([^'"]+)['"]/g;
const TOLERANCE_KEY = /\b(timeout|retries|testTimeout|hookTimeout|maxDiffPixels|maxDiffPixelRatio|threshold)\s*[:=]\s*(\d+(?:\.\d+)?)/g;
const SLEEP = /\b(?:waitForTimeout|sleep)\s*\(|\bsetTimeout\s*\(/;
const EMPTY_CATCH = /catch\s*(?:\([^)]*\))?\s*\{\s*(?:(?:\/\/[^\n]*\n\s*)|(?:\/\*[\s\S]*?\*\/\s*))*\}/;
const IGNORING_CATCH = /\.catch\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)/;

const stem = (p) => p.split('/').pop().replace(/\.(?:oracle\.)?(?:test|spec)(?=\.)/, '').replace(/\.[^.]+$/, '').replace(/^index$/, '');
const mockStem = (spec) => {
  const parts = spec.replace(/\.[cm]?[jt]sx?$/, '').split('/');
  const last = parts.pop();
  return last === 'index' ? parts.pop() ?? '' : last;
};

function tolerances(lines) {
  const out = new Map();
  for (const l of lines) for (const m of l.text.matchAll(TOLERANCE_KEY)) out.set(m[1], Number(m[2]));
  return out;
}

/** Field-level control analysis for package.json (Standard §7.13 items 5-7). Returns null when undecidable. */
function packageJsonControlFields(path, readFile, fields) {
  if (!readFile) return null;
  let base;
  let head;
  try {
    base = readFile('base', path);
    head = readFile('head', path);
    if (base === null || head === null) return null; // added or deleted: the whole file is control
    base = JSON.parse(base);
    head = JSON.parse(head);
  } catch {
    return null;
  }
  return fields.filter((f) => JSON.stringify(base[f] ?? null) !== JSON.stringify(head[f] ?? null));
}

/**
 * @param {string} diffText
 * @param {{ params: object, controlFileGlobs: string[], readFile?: (side: 'base'|'head', path: string) => string|null }} config
 * @returns {Array<{ checkId: string, level?: 'observe', ruleId?: string, location: string, message: string }>}
 */
export function scanDiff(diffText, { params: p, controlFileGlobs, readFile }) {
  const hits = [];
  const hit = (checkId, location, message, extra = {}) => hits.push({ checkId, location, message, ...extra });

  for (const file of parseUnifiedDiff(diffText)) {
    const paths = [file.oldPath, file.newPath].filter(Boolean);
    const is = (globs) => paths.some((x) => matchesAny(x, globs ?? []));
    const isTest = is(p.testFileGlobs);
    const isConfig = is(p.configFileGlobs);
    const isCode = is(p.codeFileGlobs);

    if (is(controlFileGlobs)) {
      const isPkg = file.path.endsWith('package.json');
      const changedFields = isPkg && file.status === 'modified' ? packageJsonControlFields(file.path, readFile, p.packageJsonControlFields) : null;
      if (changedFields === null) hit('integrity.control-file-change', file.path, `Control file ${file.status}: needs approval from a code owner of this file (Standard §9.10).`);
      else if (changedFields.length) hit('integrity.control-file-change', file.path, `Control fields changed (${changedFields.join(', ')}): needs approval from a code owner of this file (Standard §9.10).`);
    }
    if (is(p.oracleGlobs)) hit('integrity.oracle-lock', file.path, 'Oracle (verifier-written test or acceptance criteria) changed: only the person who approved the acceptance criteria at requirement-review may change it (Standard §7.13 item 29).');
    if (is(p.snapshotGlobs) && file.status !== 'added') hit('integrity.snapshot-churn', file.path, `Snapshot or baseline ${file.status}: must be linked to an acceptance criterion; agents never accept baselines (FE-TEST-002).`);
    if (is(p.generatedMockGlobs) && file.status === 'modified') hit('integrity.self-mocking', file.path, 'Generated mock edited by hand (FE-TEST-004): regenerate it from the contract instead.');
    if (isTest && file.status === 'deleted') hit('integrity.test-count-delta', file.path, 'Test file deleted.');
    const isScenario = is(p.scenarioFixtureGlobs) && file.status === 'modified';

    let removedCases = 0;
    let addedCases = 0;
    let removedAssertions = 0;
    let addedAssertions = 0;
    for (const hunk of file.hunks) {
      const added = hunk.lines.filter((l) => l.type === '+');
      const removed = hunk.lines.filter((l) => l.type === '-');
      const loc = (line) => `${file.path}:${line.newLine ?? line.oldLine}`;
      const hunkAddedAssertions = [];
      const hunkRemovedAssertions = [];
      let hunkAddedCases = 0;

      for (const line of added) {
        const t = line.text;
        if (SKIP_FOCUS.test(t)) hit('integrity.skip-focus', loc(line), `Skip/focus marker added: ${t.trim()}`);
        if (PASS_WITH_NO_TESTS.test(t)) hit('integrity.vacuous-test', loc(line), `Test run allowed to pass with no tests: ${t.trim()}`);
        if (SUPPRESSION.test(t)) hit('integrity.suppressions', loc(line), `Suppression added: ${t.trim()}`);
        else if (isCode && LICENSE_COMMENT.test(t)) hit('integrity.suppressions', loc(line), `Comment justifying a workaround (FE-CODE-001): ${t.trim()}`, { level: 'observe', ruleId: 'FE-CODE-001' });
        if (isConfig && !isTest && THRESHOLD.test(t)) hit('integrity.threshold-change', loc(line), `Threshold or quality setting changed: ${t.trim()}`);
        if (isTest) {
          if (ASSERTION.test(t)) hunkAddedAssertions.push(line);
          if (TEST_CASE.test(t)) hunkAddedCases++;
          if (ALWAYS_TRUE.test(t)) hit('integrity.vacuous-test', loc(line), `Assertion that is always true: ${t.trim()}`);
          if (EARLY_RETURN.test(t)) hit('integrity.vacuous-test', loc(line), 'Early `return` added in a test.');
          if (SLEEP.test(t)) hit('integrity.tolerance-inflation', loc(line), `Sleep or fixed wait added in a test: ${t.trim()}`);
          for (const m of t.matchAll(MOCK_CALL)) {
            if (mockStem(m[1]) && mockStem(m[1]) === stem(file.path)) hit('integrity.self-mocking', loc(line), `The module under test is mocked: vi.mock('${m[1]}') in ${file.path}`);
          }
        }
      }
      for (const line of removed) {
        if (isTest && ASSERTION.test(line.text)) hunkRemovedAssertions.push(line);
        if (isTest && TEST_CASE.test(line.text)) removedCases++;
      }
      addedCases += hunkAddedCases;
      addedAssertions += hunkAddedAssertions.length;
      removedAssertions += hunkRemovedAssertions.length;

      if (isTest && hunkAddedCases > 0) {
        // Per added test case: assertions between its opening line and the next added case (same hunk).
        let open = null;
        const close = () => {
          if (open && open.assertions === 0) hit('integrity.vacuous-test', `${file.path}:${open.line}`, `Test case added without any assertion: ${open.text}`);
        };
        // Context lines count as body: a modified opener (e.g. it → it.skip) keeps its unchanged assertions.
        for (const line of hunk.lines) {
          if (line.type === '-') continue;
          if (line.type === '+' && TEST_CASE.test(line.text)) {
            close();
            open = { line: line.newLine, text: line.text.trim(), assertions: ASSERTION.test(line.text) ? 1 : 0 };
          } else if (line.type === ' ' && TEST_CASE.test(line.text)) {
            close();
            open = null;
          } else if (open && ASSERTION.test(line.text)) open.assertions++;
        }
        close();
      }
      if (isTest && file.status !== 'added') {
        const pairs = Math.min(hunkRemovedAssertions.length, hunkAddedAssertions.length);
        for (let i = 0; i < pairs; i++) {
          hit('integrity.expected-value-edit', loc(hunkAddedAssertions[i]), `Expected value changed: "${hunkRemovedAssertions[i].text.trim()}" → "${hunkAddedAssertions[i].text.trim()}"`);
        }
      }
      if (isScenario && removed.length && added.length) {
        hit('integrity.expected-value-edit', loc(added[0]), 'Existing scenario fixture changed: counts as editing an expected value (FE-TEST-004).');
      }
      const before = tolerances(removed);
      for (const [key, value] of tolerances(added)) {
        if (!before.has(key) || value > before.get(key)) {
          hit('integrity.tolerance-inflation', `${file.path}:${added[0].newLine}`, `${key} ${before.has(key) ? `raised ${before.get(key)} → ${value}` : `set to ${value}`}`);
        }
      }
      if (isCode && !isTest) {
        const addedText = added.map((l) => l.text).join('\n');
        if (EMPTY_CATCH.test(addedText) || IGNORING_CATCH.test(addedText)) {
          hit('integrity.broad-catch', `${file.path}:${added[0].newLine}`, 'Error swallowed: empty or ignoring catch added in production code.');
        }
      }
    }
    if (isTest && file.status !== 'deleted') {
      if (removedCases > addedCases) hit('integrity.test-count-delta', file.path, `${removedCases - addedCases} test case(s) removed.`);
      if (removedAssertions > addedAssertions) hit('integrity.test-count-delta', file.path, `${removedAssertions - addedAssertions} assertion(s) removed.`);
    }
  }
  return hits;
}
