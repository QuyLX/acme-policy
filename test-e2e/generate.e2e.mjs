// Generator end-to-end proof (tech-design 12 AC-1/2/3; DV-04): in a throwaway copy of the product repo, generate an
// app, a package and a DS component, install offline, run the central checks, then start the app and fetch its page.
// Opt-in (slow): `pnpm test:e2e`. Uses FACTORY_E2E_PRODUCT or ../acme-frontend. Leaves nothing behind.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { POLICY_ROOT } from '../lib/io.mjs';

const product = resolve(process.env.FACTORY_E2E_PRODUCT ?? join(POLICY_ROOT, '..', 'acme-frontend'));
const SKIP = new Set(['node_modules', '.next', '.nx', 'dist', 'storybook-static', '.vitest', '.git']);
const root = mkdtempSync(join(tmpdir(), 'acme-e2e-'));
const repo = join(root, 'acme-frontend');
const env = { ...process.env, FACTORY_POLICY_DIR: join(root, 'acme-policy'), CI: 'true' };
const sh = (cmd, args, cwd = repo, o = {}) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...o });
  if (r.status !== 0 && !o.allowFail) throw new Error(`${cmd} ${args.join(' ')} → ${r.status}\n${(r.stdout + r.stderr).split('\n').slice(-25).join('\n')}`);
  return r;
};
const step = (msg) => console.log(`\n▶ ${msg}`);
const policy = (...args) => {
  const o = typeof args.at(-1) === 'object' ? args.pop() : {};
  return sh(process.execPath, [join(POLICY_ROOT, 'bin', 'acme-policy.mjs'), ...args], repo, o);
};
const checkpoint = join(POLICY_ROOT, 'checks/generate/fixtures/design-review-passed.json');
let server;
let failed = false;
try {
  step(`copy ${product} → ${repo}`);
  symlinkSync(POLICY_ROOT, join(root, 'acme-policy'));
  cpSync(product, repo, { recursive: true, filter: (src) => !SKIP.has(src.split('/').pop()) });
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', 'add', '-A']);
  sh('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
  step('pnpm install --offline --frozen-lockfile');
  sh('pnpm', ['install', '--offline', '--frozen-lockfile']);

  step('generate app e2e-app, package e2e-lib, ds-component StatusDot');
  const noCheckpoint = sh(process.execPath, [join(POLICY_ROOT, 'bin', 'acme-policy.mjs'), 'generate', 'app', 'e2e-app', '--repo', repo], repo, { allowFail: true });
  if (noCheckpoint.status !== 1) throw new Error('generate app without design-review must refuse (exit 1)');
  console.log('  ✓ refused without design-review');
  policy('generate', 'app', 'e2e-app', '--repo', repo, '--port', '3999', '--checkpoint', checkpoint);
  policy('generate', 'package', 'e2e-lib', '--repo', repo, '--kind', 'node-lib', '--checkpoint', checkpoint);
  policy('generate', 'ds-component', 'StatusDot', '--repo', repo);
  // The generated projects change the lockfile, so resolution needs registry metadata.
  // FACTORY_E2E_OFFLINE=1 keeps the old offline install for a warm local store.
  const postInstall = process.env.FACTORY_E2E_OFFLINE === '1'
    ? ['install', '--offline', '--no-frozen-lockfile']
    : ['install', '--no-frozen-lockfile'];
  step(`pnpm ${postInstall.join(' ')} (new workspace projects)`);
  sh('pnpm', postInstall);

  step('central checks on the generated output');
  const checks = ['meta.config-parity', 'meta.toolchain-pin', 'meta.descriptor-drift', 'quality.lint', 'quality.typecheck', 'quality.test', 'quality.build', 'arch.cycles', 'integrity.control-file-change', 'policy.risk'];
  const run = JSON.parse(policy('run', '--repo', repo, '--base', 'HEAD', '--checks', checks.join(','), { allowFail: true }).stdout);
  for (const c of run.checks) console.log(`  ${c.status.padEnd(12)} ${c.checkId}${c.status === 'PASS' ? '' : `\n${(c.reason ?? '').split('\n').slice(0, 15).join('\n')}`}`);
  if (run.checks.some((c) => c.status !== 'PASS')) throw new Error('generated output does not pass the central checks');

  step('next start e2e-app and fetch /');
  server = spawn(join(repo, 'apps/e2e-app/node_modules/.bin/next'), ['start', '--port', '3999'], { cwd: join(repo, 'apps/e2e-app'), env });
  let html = '';
  for (let i = 0; i < 60 && !html; i++) {
    await new Promise((r) => setTimeout(r, 500));
    html = await fetch('http://localhost:3999/').then((r) => (r.ok ? r.text() : ''), () => '');
  }
  const expectations = { 'i18n (vi default)': 'Đang hoạt động', 'DS EmptyState': 'Chưa có dữ liệu', 'server context tenant': '00000001-0000-4000-8000-000000000001', 'token CSS': '--ds-color' };
  const css = html ? await Promise.all([...html.matchAll(/href="(\/_next\/static\/[^"]+\.css)"/g)].map((m) => fetch(`http://localhost:3999${m[1]}`).then((r) => r.text()))) : [];
  for (const [what, needle] of Object.entries(expectations)) {
    const ok = what === 'token CSS' ? css.join('').includes(needle) : html.includes(needle);
    console.log(`  ${ok ? '✓' : '✗'} ${what}`);
    if (!ok) failed = true;
  }
  if (failed) throw new Error('rendered page is missing expected content');
  console.log('\n✓ generator end-to-end proof passed');
} catch (err) {
  failed = true;
  console.error(`\n✗ ${err.message}`);
} finally {
  server?.kill();
  rmSync(root, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}
