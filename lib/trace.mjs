// `factory trace <req|journey|AC>` (FE §7.7 "Traceability from requirement to evidence"; FE §8.11; SC-19 / CORE-VER-04):
//   Requirement (tracker) → Journey → AC → Scenario → Test case (tags) → CheckResult → VerificationRun
// Journeys come from journeys.yaml (curated: requirements [req:KEY], scenarios[].ac, acceptance[]); test cases from
// `@journey:` / `@scenario:` / `@ac:` tags in test titles; evidence from VerificationRuns whose CheckResults list
// the test cases they ran (`extensions['x-test-cases']`) and the ACs they cover (`extensions['x-fe']`, FE §8.5).
// Gaps: `trace.unknown-ref`, `trace.ac-without-test`, `trace.no-pass-evidence`, `trace.dangling-tag`;
// a complete chain gives `trace.complete`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const TAG = /@(journey|scenario|ac):([\w./:-]+)/g;
const TITLE = /\b(?:test|it)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

/** Test cases with their tags, from the source of test files: [{ id, file, title, journey, scenario, ac[] }]. */
export function testCasesFrom(testFiles) {
  const out = [];
  for (const { path, content } of testFiles) {
    for (const m of content.matchAll(TITLE)) {
      const title = m[2];
      const tags = { journey: [], scenario: [], ac: [] };
      for (const t of title.matchAll(TAG)) tags[t[1]].push(t[2]);
      if (!tags.journey.length && !tags.ac.length) continue;
      out.push({ id: `${path}::${title}`, file: path, title, journeys: tags.journey, scenarios: tags.scenario, ac: tags.ac });
    }
  }
  return out;
}

/** Reads test files (`*.test.*`) under a directory or from a list of files, with paths relative to `root`. */
export function readTestFiles(paths, root) {
  const files = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p)) if (f !== 'node_modules' && !f.startsWith('.')) walk(join(p, f));
    } else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) files.push({ path: relative(root, p), content: readFileSync(p, 'utf8') });
  };
  for (const p of paths) walk(p);
  return files;
}

const finished = (run) => run.provenance?.finishedAt ?? '';

/** Most recent evidence for one test case across runs: { status, runId, commitSha, checkId, finishedAt } or null. */
function evidenceFor(testCase, runs) {
  let best = null;
  for (const run of runs) {
    for (const c of run.checks ?? []) {
      const tc = (c.extensions?.['x-test-cases'] ?? []).find((t) => t.id === testCase.id || (t.title === testCase.title && (!t.file || t.file === testCase.file)));
      if (!tc) continue;
      const e = { status: tc.status, runId: run.runId, commitSha: run.subject?.commitSha, checkId: c.checkId, finishedAt: finished(run) };
      if (!best || e.finishedAt > best.finishedAt) best = e;
    }
  }
  return best;
}

/**
 * @param {string} ref `req:KEY`, a journey id, or an AC id
 * @param {{ journeys: object[], testFiles: Array<{ path: string, content: string }>, runs: object[] }} sources
 * @returns {{ ref: string, complete: boolean, chain: object[], findings: object[] }}
 */
export function trace(ref, { journeys, testFiles, runs }) {
  const findings = [];
  const f = (ruleId, severity, location, message) => findings.push({ source: 'check', ruleId, severity, location, message, state: 'open' });
  const cases = testCasesFrom(testFiles);
  const knownAc = new Set(journeys.flatMap((j) => [...(j.acceptance ?? []).map((a) => a.id), ...(j.scenarios ?? []).flatMap((s) => s.ac ?? [])]));
  for (const t of cases) for (const ac of t.ac) if (!knownAc.has(ac)) f('trace.dangling-tag', 'WARNING', t.id, `test is tagged @ac:${ac}, which no journey declares (FE §7.7)`);

  const selected = journeys.flatMap((j) => {
    const acs = [...new Set([...(j.scenarios ?? []).flatMap((s) => s.ac ?? []), ...(j.acceptance ?? []).map((a) => a.id)])];
    if (ref.startsWith('req:')) return (j.requirements ?? []).includes(ref) ? acs.map((ac) => ({ j, ac })) : [];
    if (j.id === ref) return acs.map((ac) => ({ j, ac }));
    return acs.includes(ref) ? [{ j, ac: ref }] : [];
  });
  if (!selected.length) f('trace.unknown-ref', 'BLOCKER', ref, `${ref} is not a requirement, journey or AC of the Journey Registry`);

  const chain = selected.map(({ j, ac }) => {
    const scenarios = (j.scenarios ?? []).filter((s) => (s.ac ?? []).includes(ac)).map((s) => s.id);
    const tests = cases
      .filter((t) => t.ac.includes(ac) && (!t.journeys.length || t.journeys.includes(j.id)))
      .map((t) => ({ id: t.id, scenarios: t.scenarios, evidence: evidenceFor(t, runs) }));
    if (!tests.length) f('trace.ac-without-test', 'BLOCKER', `${j.id}#${ac}`, `${ac} of ${j.id} has no test tagged @ac:${ac} (FE §7.7)`);
    for (const t of tests) {
      if (t.evidence?.status !== 'PASS') f('trace.no-pass-evidence', 'BLOCKER', t.id, `${ac}: the most recent evidence for this test is ${t.evidence ? `${t.evidence.status} in ${t.evidence.runId} on ${t.evidence.commitSha}` : 'missing'}; no PASS evidence`);
    }
    return { requirements: j.requirements ?? [], journey: j.id, ac, statement: (j.acceptance ?? []).find((a) => a.id === ac)?.statement, scenarios, tests };
  });
  const complete = selected.length > 0 && !findings.some((x) => x.severity === 'BLOCKER');
  if (complete) f('trace.complete', 'INFO', ref, `${ref}: ${chain.length} AC, every AC has a test with PASS evidence (${[...new Set(chain.flatMap((c) => c.tests.map((t) => `${t.evidence.runId}@${t.evidence.commitSha}`)))].join(', ')})`);
  return { ref, complete, chain, findings };
}
