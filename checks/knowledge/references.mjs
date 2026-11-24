// knowledge.references — references inside knowledge records resolve (CORE-KNW-07; FE §8.4 Documentation &
// Knowledge): basedOn/supersedes IDs exist, relative Markdown links resolve, every `describes` glob matches a file.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadArtifacts } from '../knowledge-impact/impact.mjs';
import { readFrontmatter } from '../../lib/io.mjs';
import { listFiles } from '../../lib/files.mjs';
import { matchesAny } from '../../lib/glob.mjs';
import { checkResult } from '../../lib/result.mjs';

const LINK = /\]\((?!https?:|mailto:|#)([^)\s#]+)(?:#[^)]*)?\)/g;

export function referencesCheck(def, repo) {
  const artifacts = loadArtifacts(repo, def.params.docsGlobs).filter((a) => !a.errors.length);
  const ids = new Set(artifacts.map((a) => a.meta.id));
  const files = listFiles(repo);
  const problems = [];
  for (const a of artifacts) {
    for (const ref of [...(a.meta.basedOn ?? []), ...(a.meta.supersedes ?? [])]) {
      const id = String(ref).split('@')[0];
      if (!ids.has(id)) problems.push({ location: a.path, message: `references ${ref}, which is not a known record` });
    }
    for (const glob of a.meta.describes ?? []) {
      if (!files.some((f) => matchesAny(f, [glob]))) problems.push({ location: a.path, message: `describes "${glob}", which matches no file` });
    }
    const { body } = readFrontmatter(join(repo, a.path));
    for (const m of body.matchAll(LINK)) {
      if (!existsSync(join(repo, dirname(a.path), decodeURI(m[1])))) problems.push({ location: a.path, message: `link to ${m[1]} does not resolve` });
    }
  }
  return checkResult(def, {
    status: problems.length && def.enforcement === 'blocking' ? 'FAIL' : 'PASS',
    findings: problems.map((p) => ({ source: 'check', ruleId: def.checkId, severity: def.enforcement === 'blocking' ? 'BLOCKER' : 'INFO', state: 'open', ...p })),
    extensions: { 'x-broken': problems.length },
  });
}
