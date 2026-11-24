// Repository file walk shared by repo-level checks. Skips dependency, build and VCS directories.
import { readdirSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.next', '.nx', 'dist', 'storybook-static', 'coverage', 'out']);

export function listFiles(root, dir = root, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) listFiles(root, full, out);
    else out.push(relative(root, full));
  }
  return out;
}
