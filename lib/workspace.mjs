// Project discovery for a product repo: pnpm-workspace.yaml globs + each package.json `name`.
// Never reads package.json scripts or build-tool targets (DV-05: repo scripts never decide a verification result).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/** @returns {Array<{ name: string, dir: string, abs: string }>} sorted by dir */
export function discoverProjects(repo) {
  const ws = join(repo, 'pnpm-workspace.yaml');
  if (!existsSync(ws)) return [];
  const globs = parseYaml(readFileSync(ws, 'utf8'))?.packages ?? [];
  const dirs = new Set();
  for (const glob of globs) {
    if (glob.startsWith('!')) continue;
    if (glob.endsWith('/*')) {
      const parent = join(repo, glob.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const child of readdirSync(parent)) if (statSync(join(parent, child)).isDirectory()) dirs.add(`${glob.slice(0, -2)}/${child}`);
    } else if (!glob.includes('*')) dirs.add(glob.replace(/\/$/, ''));
    else throw new Error(`pnpm-workspace.yaml glob "${glob}" is not supported (use "dir/*" or an exact path)`);
  }
  return [...dirs]
    .filter((dir) => existsSync(join(repo, dir, 'package.json')))
    .map((dir) => ({ dir, abs: join(repo, dir), name: JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8')).name }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

export function hasNx(repo) {
  return existsSync(join(repo, 'nx.json'));
}
