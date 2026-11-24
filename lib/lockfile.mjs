// pnpm lockfile reader. pnpm 12 writes several YAML documents separated by `---` (the first one pins the package
// manager itself, verified 2026-11-24 with pnpm 12.23.0); packages of every document are merged.
import { parseAllDocuments } from 'yaml';

export function lockfilePackages(text) {
  const packages = {};
  for (const doc of parseAllDocuments(text)) {
    const data = doc.toJS() ?? {};
    Object.assign(packages, data.packages ?? {});
  }
  return packages;
}
