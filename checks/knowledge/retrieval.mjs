// knowledge.retrieval — retrieval results obey the Knowledge Index rules (FE §7.8 rules 1-3; FE §12 knowledge retrieval
// targets: access leakage = 0, non-ACTIVE without a marker = 0, correct source and version, complete citation;
// CORE-KNW-05, CORE-SEC-02). The results under test are either recorded from a retrieval engine (`results`, e.g. an
// external search host being evaluated) or produced live by lib/knowledge-index.mjs `search`.
// Status is the outcome; the registry enforcement decides whether it blocks (FE §8.2).
import { checkResult } from '../../lib/result.mjs';
import { appliesToPins, canRead, citationComplete, search } from '../../lib/knowledge-index.mjs';
import { loadKnowledgeInput } from './index-input.mjs';

export function retrievalProblems(index, pins, requester, question, results) {
  const byId = new Map(index.extensions['x-fe'].entries.map((e) => [e.id, e]));
  const out = [];
  const add = (ruleId, message) => out.push({ ruleId, location: question.id, message });
  for (const r of results) {
    const e = byId.get(r.id);
    if (!e) { add('KNW-UNKNOWN-RESULT', `${r.id} is not in the index: a result must point back to an indexed source`); continue; }
    if (!canRead(e, requester)) add('KNW-ACCESS-LEAK', `${r.id} (${e.visibility}) returned to ${requester.id}, who cannot read it at the source (FE §7.8 rule 1)`);
    if (e.status !== 'ACTIVE' && !r.marker) add('KNW-UNMARKED-NON-ACTIVE', `${r.id} is ${e.status} and returned without a marker (FE §7.8 rule 2)`);
    if (!appliesToPins(e.appliesTo, pins)) add('KNW-VERSION-MISMATCH', `${r.id} applies to ${JSON.stringify(e.appliesTo)}, not to the pinned versions (FE §7.3)`);
    if (!citationComplete(r) || r.version !== e.version) add('KNW-CITATION', `${r.id}: a result needs URI@SHA, authority and the indexed version (FE §7.8 rule 3)`);
  }
  for (const id of question.expect?.ids ?? []) if (!results.some((r) => r.id === id)) add('KNW-RETRIEVAL-MISS', `expected source ${id} not returned for "${question.query}"`);
  for (const id of question.expect?.absent ?? []) if (results.some((r) => r.id === id)) add('KNW-RETRIEVAL-UNEXPECTED', `${id} must not be returned for "${question.query}"`);
  return out;
}

export function retrievalCheck(def, ctx) {
  const started = Date.now();
  if (!ctx.input) return checkResult(def, { status: 'NOT_ASSESSED', reason: 'no retrieval question set (--input)' });
  let loaded;
  try {
    loaded = loadKnowledgeInput(ctx.input);
  } catch (err) {
    return checkResult(def, { status: 'ERROR', reason: `retrieval input: ${err.message}` });
  }
  const { spec, index, pins, requester } = loaded;
  const findings = [];
  const answers = {};
  for (const q of spec.questions ?? []) {
    const results = spec.results?.[q.id] ?? search(index, q.query, { requester, pins, includeDraft: q.includeDraft, now: spec.now }).results;
    answers[q.id] = results.map((r) => `${r.id}@${r.version}${r.marker ? ` ${r.marker}` : ''}`);
    for (const p of retrievalProblems(index, pins, requester, q, results)) findings.push({ source: 'check', severity: 'BLOCKER', state: 'open', ...p });
  }
  return checkResult(def, {
    status: findings.length ? 'FAIL' : 'PASS',
    reason: findings.length ? [...new Set(findings.map((f) => f.ruleId))].join(', ') : undefined,
    findings,
    durationMs: Date.now() - started,
    extensions: { 'x-answers': answers, 'x-engine': spec.results ? 'recorded' : 'builtin', 'x-index-built-at': index.extensions['x-fe'].builtAt },
  });
}
