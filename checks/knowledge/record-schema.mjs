// knowledge.record-schema — every knowledge record's frontmatter is valid (CORE-KNW-06; FE §7.3). Shadow in Wave 1
// (FE §8.9): runs for real, never blocks, until false-positive data exists.
import { loadArtifacts } from '../knowledge-impact/impact.mjs';
import { checkResult } from '../../lib/result.mjs';

export function recordSchemaCheck(def, repo) {
  const bad = loadArtifacts(repo, def.params.docsGlobs).filter((a) => a.errors.length);
  return checkResult(def, {
    status: bad.length && def.enforcement === 'blocking' ? 'FAIL' : 'PASS',
    findings: bad.map((a) => ({ source: 'check', ruleId: def.checkId, severity: def.enforcement === 'blocking' ? 'BLOCKER' : 'INFO', location: a.path, message: `Invalid frontmatter: ${a.errors.join('; ')}`, state: 'open' })),
    extensions: { 'x-invalid': bad.length },
  });
}
