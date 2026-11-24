// The pinned verification kit (registry/kits.yaml) and a product repo's factory.config.yaml.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readYaml, policyPath } from './io.mjs';
import { validate } from './schema.mjs';

export function kitRegistry() {
  return readYaml(policyPath('registry', 'kits.yaml'));
}

export function kit() {
  const reg = kitRegistry();
  const dir = policyPath(reg.kit.dir);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.version !== reg.kit.version) throw new Error(`kit ${reg.kit.package}@${pkg.version} on disk ≠ pinned ${reg.kit.version} (registry/kits.yaml)`);
  return { dir, version: reg.kit.version, productTools: reg.productTools, installed: existsSync(join(dir, 'node_modules', 'eslint')) };
}

export function adapterDef(adapterId) {
  const def = readYaml(policyPath('registry', 'adapters.yaml')).adapters.find((a) => a.adapterId === adapterId);
  if (!def) throw new Error(`Unknown adapter: ${adapterId} (not in registry/adapters.yaml)`);
  return def;
}

/** @returns {{ config: object|null, errors: string[] }} */
export function readProjectConfig(repo, text) {
  const file = join(repo, 'factory.config.yaml');
  if (text === undefined) {
    if (!existsSync(file)) return { config: null, errors: ['factory.config.yaml is missing'] };
    text = readFileSync(file, 'utf8');
  }
  const config = parseYaml(text);
  const errors = validate('factory-project-config', config);
  return { config: errors.length ? null : config, errors: errors.map((e) => `factory.config.yaml ${e}`) };
}
