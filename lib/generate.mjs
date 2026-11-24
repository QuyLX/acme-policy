// Generators (tech-design 12; FE §9.8, §9.11, §10.1). Deterministic: the same inputs and generator version always
// produce byte-identical output (no timestamps, sorted keys) — the condition for the `factory.generate` trusted
// mechanism (Standard §7.13).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readYaml, policyPath } from './io.mjs';
import { kit } from './kit.mjs';

// Versions aligned with the repo's existing pins (ds-react); tools that verification runs from the product install
// come from registry/kits.yaml so a generated project never fails meta.toolchain-pin.
const BASE_DEV = { '@types/node': '26.6.6', eslint: '10.15.0', typescript: '6.0.3' };
const REACT_DEV = {
  '@testing-library/react': '16.3.3', '@types/react': '19.3.0', '@types/react-dom': '19.3.0', '@vitejs/plugin-react': '6.3.0',
  jsdom: '31.0.1', react: '19.3.1', 'react-dom': '19.3.1', vite: '8.3.8',
};

export function generator(id) {
  const g = readYaml(policyPath('generators', 'registry.yaml')).generators.find((x) => x.id === id);
  if (!g) throw new Error(`unknown generator ${id} (generators/registry.yaml)`);
  return g;
}

export function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`template variable {{${k}}} has no value`);
    return vars[k];
  });
}

function templateFiles(id) {
  const root = policyPath('generators', id, 'template');
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const f = join(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else out.push({ rel: relative(root, f).replace(/\.tmpl$/, ''), text: readFileSync(f, 'utf8') });
    }
  };
  walk(root);
  return out;
}

/**
 * A design-review checkpoint is a CheckpointRecord (Standard Appendix K.4) produced on the platform. Machine-checked:
 * right checkpoint, passed, at least one approval, no agent approver (Standard §9.10 item 1).
 */
export function verifyCheckpoint(path, expected) {
  if (!path) return `a ${expected} checkpoint is required (FE §9.11): pass --checkpoint <CheckpointRecord.json>`;
  if (!existsSync(path)) return `checkpoint record ${path} does not exist`;
  let r;
  try {
    r = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return `checkpoint record ${path} is not valid JSON`;
  }
  if (r.checkpoint !== expected) return `checkpoint is ${r.checkpoint}, expected ${expected}`;
  if (r.outcome !== 'passed') return `checkpoint outcome is ${r.outcome}, expected passed`;
  if (!r.approvals?.length) return 'checkpoint has no approval';
  if (r.approvals.some((a) => String(a.by).startsWith('agent:'))) return 'an agent cannot approve a design-review (Standard §9.10)';
  return null;
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

/** @returns {{ files: Record<string,string>, configEntry: string, generator: object }} */
export function planPackage({ repo, name, kind, description }) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`package name "${name}" must be kebab-case`);
  if (!['react-lib', 'node-lib'].includes(kind)) throw new Error('--kind must be react-lib or node-lib');
  const g = generator('package');
  const dir = render(g.target, { name });
  if (existsSync(join(repo, dir))) throw new Error(`${dir} already exists; generators never overwrite`);
  const dev = sorted({ ...BASE_DEV, vitest: kit().productTools.vitest, ...(kind === 'react-lib' ? REACT_DEV : {}) });
  const vars = { name, description, generatorVersion: g.version, devDependencies: JSON.stringify(dev, null, 4).replace(/\n}/, '\n  }') };
  const files = Object.fromEntries(templateFiles('package').map((t) => [`${dir}/${t.rel}`, render(t.text, vars)]));
  const configEntry = `  "@platform/${name}":\n    kind: ${kind}\n    test:\n      environment: ${kind === 'react-lib' ? 'jsdom' : 'node'}\n`;
  return { files, configEntry, generator: g, dir };
}

export function planDsComponent({ repo, name, summary }) {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error(`component name "${name}" must be PascalCase`);
  const g = generator('ds-component');
  const dsDir = 'packages/ds-react';
  const kebab = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const dir = render(g.target, { dir: kebab });
  if (existsSync(join(repo, dir))) throw new Error(`${dir} already exists; generators never overwrite`);
  const vars = { Name: name, NAME: kebab.toUpperCase().replace(/-/g, ''), PFX: kebab.replace(/-/g, '').slice(0, 3).toUpperCase(), dir: kebab, summary };
  const files = {};
  for (const t of templateFiles('ds-component')) {
    if (t.rel === 'contract.md') files[`${dsDir}/docs/components/${name}.contract.md`] = render(t.text, vars);
    else files[`${dir}/${t.rel.replace('Component', name)}`] = render(t.text, vars);
  }
  const exportLines = `export { ${name} } from './${kebab}/${name}';\nexport type { ${name}Props } from './${kebab}/${name}';\n`;
  return { files, exportLines, indexPath: `${dsDir}/src/index.ts`, generator: g, dir };
}

const PRIVILEGED_RISKMAP = (name) => [
  `  - paths: ["apps/${name}/**"]`,
  '    tier: Medium',
  '    subTier: R2',
  '    reason: "x:privileged-admin floor: every change is at least R2"',
  '    source: "FE §10.1"',
  '  - paths:',
  `      - "apps/${name}/src/**/{impersonation,impersonate,break-glass,step-up,cross-tenant,bulk,export,audit,pii}/**"`,
  `      - "apps/${name}/src/server/{session,authz,auth}/**"`,
  '    tier: High',
  '    subTier: R3',
  '    reason: "privileged path (FE §10.1)"',
  '    source: "FE §10.1"',
].join('\n');

/** Next.js app wired to the platform (tech-design 12 §3). `privilegedAdmin` adds the FE §10.1 risk floor. */
export function planApp({ repo, name, port = 3002, privilegedAdmin = false }) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`app name "${name}" must be kebab-case`);
  const g = generator('app');
  const dir = render(g.target, { name });
  if (existsSync(join(repo, dir))) throw new Error(`${dir} already exists; generators never overwrite`);
  const title = name.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  const vars = {
    name, port: String(port), title, owner: `team-${name}`, generatorVersion: g.version, vitestVersion: kit().productTools.vitest,
    riskMap: privilegedAdmin ? PRIVILEGED_RISKMAP(name) : '  []   # unmatched paths are High until owners declare tiers (Standard §9.5 rule 4)',
  };
  const files = Object.fromEntries(templateFiles('app').map((t) => [`${dir}/${t.rel}`, render(t.text, vars)]));
  const configEntry = `  ${name}:\n    kind: next-app\n    test:\n      environment: node\n`;
  return { files, configEntry, generator: g, dir };
}
