// Shared input of knowledge.retrieval and knowledge.basis: a YAML/JSON file (ctx.input) naming the Knowledge Index
// sources, the requester's repo (its pinned versions) and the requester identity. Paths are relative to the policy root.
import { isAbsolute } from 'node:path';
import { readJson, readYaml, policyPath } from '../../lib/io.mjs';
import { indexFromSourcesFile, repoPins } from '../../lib/knowledge-index.mjs';

const at = (p) => (isAbsolute(p) ? p : policyPath(p));

export function loadKnowledgeInput(input) {
  const spec = input.endsWith('.json') ? readJson(input) : readYaml(input);
  const index = indexFromSourcesFile(at(spec.sources), at);
  const pins = spec.repo ? repoPins(at(spec.repo)) : spec.pins ?? {};
  return { spec, index, pins, requester: spec.requester ?? {} };
}
