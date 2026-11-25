// RuleTester fixtures for the @acme profile rules (FE §4.5: every rule has pass and fail fixtures).
import { describe, it } from 'node:test';
import { RuleTester } from '../presets/node_modules/eslint/lib/api.js';
import acme from '../presets/eslint/rules/index.mjs';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;
const tester = new RuleTester({ languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } } });
const R = acme.rules;

tester.run('FE-DS-001 no-hardcoded-design-values', R['no-hardcoded-design-values'], {
  valid: [
    '<div className="bg-surface text-fg p-4 gap-2" />',
    '<div style={{ color: "var(--color-fg)", padding: "var(--space-4)" }} />',
    'const c = `var(--color-fg)`;',
  ],
  invalid: [
    { code: '<div className="bg-[#ff0000] p-4" />', errors: [{ messageId: 'arbitrary' }] },
    { code: '<div className={cx("rounded", "p-[13px]")} />', errors: [{ messageId: 'arbitrary' }] },
    { code: '<div style={{ color: "#ff0000" }} />', errors: [{ messageId: 'style' }] },
    { code: '<div style={{ marginTop: "13px" }} />', errors: [{ messageId: 'style' }] },
    { code: 'const c = `var(--color-${tone})`;', errors: [{ messageId: 'concat' }] },
    { code: 'const c = "var(--color-" + tone + ")";', errors: [{ messageId: 'concat' }] },
  ],
});

tester.run('FE-UX-001 no-raw-interactive-elements', R['no-raw-interactive-elements'], {
  valid: ['<Button onPress={save}>Save</Button>', '<div role="presentation" />'],
  invalid: [
    { code: '<button onClick={save}>Save</button>', errors: [{ messageId: 'raw' }] },
    { code: '<input value={v} />', errors: [{ messageId: 'raw' }] },
  ],
});

tester.run('FE-ARCH-001 no-private-module-import', R['no-private-module-import'], {
  valid: [
    { code: "import { list } from '../../billing';", filename: '/repo/apps/console/src/modules/compute/features/list.tsx' },
    { code: "import { list } from '../../billing/index';", filename: '/repo/apps/console/src/modules/compute/features/list.tsx' },
    { code: "import { row } from '../ui/row';", filename: '/repo/apps/console/src/modules/compute/features/list.tsx' },
    { code: "import { list } from '@/modules/billing';", filename: '/repo/apps/console/src/modules/compute/features/list.tsx' },
    { code: "import { readTenant } from '../../tenants';", filename: '/repo/apps/admin/src/domains/users/server/read.ts' },
    { code: "import { x } from '../ui/row';", filename: '/repo/apps/admin/src/domains/users/server/read.ts' },
    { code: "import { readTenant } from '@/domains/tenants';", filename: '/repo/apps/admin/src/domains/users/server/read.ts' },
  ],
  invalid: [
    { code: "import { price } from '../../billing/domain/price';", filename: '/repo/apps/console/src/modules/compute/features/list.tsx', errors: [{ messageId: 'private' }] },
    { code: "import { price } from '@/modules/billing/domain/price';", filename: '/repo/apps/console/src/modules/compute/features/list.tsx', errors: [{ messageId: 'private' }] },
    { code: "import { readTenant } from '../../tenants/server/read';", filename: '/repo/apps/admin/src/domains/users/server/read.ts', errors: [{ messageId: 'private' }] },
    { code: "import { readTenant } from '@/domains/tenants/server/read';", filename: '/repo/apps/admin/src/domains/users/server/read.ts', errors: [{ messageId: 'private' }] },
  ],
});

tester.run('FE-ARCH-006 no-app-import-in-package', R['no-app-import-in-package'], {
  valid: [
    { code: "import { cx } from './cx';", filename: '/repo/packages/ds-react/src/button/Button.tsx' },
    { code: "import x from '../../apps/admin/x';", filename: '/repo/apps/console/src/a.ts' },
  ],
  invalid: [
    { code: "import { Page } from '../../../apps/admin/src/app/page';", filename: '/repo/packages/ds-react/src/button/Button.tsx', errors: [{ messageId: 'app' }] },
  ],
});

tester.run('FE-STATE-002 no-effect-fetch', R['no-effect-fetch'], {
  valid: [
    'useEffect(() => { document.title = title; }, [title]);',
    'const data = await fetch(url);',
  ],
  invalid: [
    { code: 'useEffect(() => { fetch("/api/x").then(setX); }, []);', errors: [{ messageId: 'fetch' }, { messageId: 'fetch' }] },
    { code: 'React.useEffect(() => { load().then(setX); }, []);', errors: [{ messageId: 'fetch' }] },
    { code: 'useEffect(() => { setTimeout(() => focus(), 0); }, []);', errors: [{ messageId: 'timing' }] },
  ],
});

tester.run('FE-API-001 no-raw-service-fetch', R['no-raw-service-fetch'], {
  valid: [
    'await listUsers(ctx, {});',
    "await fetch('/api/local');",
    'await fetch(`http://127.0.0.1:3011${path}`);',
    "await fetch('http://localhost:3001/tenants');",
  ],
  invalid: [
    { code: "await fetch('https://users.internal/v1/users');", errors: [{ messageId: 'raw' }] },
    { code: "await fetch('https://tenants.example/v1/tenants');", errors: [{ messageId: 'raw' }] },
    { code: 'await fetch(`https://${host}/v1/users`);', errors: [{ messageId: 'raw' }] },
  ],
});

tester.run('FE-NEXT-001 server-only-clients', R['server-only-clients'], {
  valid: ["import 'server-only';\nimport { listUsers } from '../__generated__/users/client';"],
  invalid: [{ code: "import { listUsers } from '../__generated__/users/client';", errors: [{ messageId: 'client' }] }],
});

tester.run('FE-NEXT-002 wrapped-server-actions', R['wrapped-server-actions'], {
  valid: [
    "'use server';\nexport const renameTenant = defineMutation({ input, authorize, handler }, deps);",
    'export async function notAnAction() {}',
  ],
  invalid: [
    { code: "'use server';\nexport async function renameTenant(form) { await db.update(form); }", errors: [{ messageId: 'bare' }] },
    { code: "'use server';\nexport const renameTenant = async (form) => db.update(form);", errors: [{ messageId: 'bare' }] },
  ],
});

tester.run('FE-NEXT-005 no-direct-data-cache', R['no-direct-data-cache'], {
  valid: [{ code: 'const users = await cachedForTenant(ctx, ["users"], load);', filename: '/repo/apps/admin/src/a.ts' }],
  invalid: [
    { code: "import { unstable_cache } from 'next/cache';", filename: '/repo/apps/admin/src/a.ts', errors: [{ messageId: 'direct' }] },
    { code: "async function f() { 'use cache'; return 1; }", filename: '/repo/apps/admin/src/a.ts', errors: [{ messageId: 'direct' }] },
    { code: "await fetch('/x', { next: { revalidate: 60 } });", filename: '/repo/apps/admin/src/a.ts', errors: [{ messageId: 'direct' }] },
  ],
});

tester.run('FE-CTX-001 tenant-query-key', R['tenant-query-key'], {
  valid: ["useQuery({ queryKey: tenantQueryKey(ctx, 'users'), queryFn });", 'useQuery(options);'],
  invalid: [
    { code: "useQuery({ queryKey: ['users', page], queryFn });", errors: [{ messageId: 'key' }] },
    { code: "queryClient.prefetchQuery({ queryKey: ['tenants'], queryFn });", errors: [{ messageId: 'key' }] },
  ],
});

// export.csv-injection (FE §8.4 cap:import-export): the rule export.csv-injection runs; not in a PROFILE_RULES kind yet.
tester.run('export.csv-injection csv-safe-export', R['csv-safe-export'], {
  valid: [
    "function GET(rows) { return new Response(toCsv(rows, ['id']), { headers: { 'content-type': 'text/csv' } }); }",
    "function GET(rows) { const body = toCsv(rows, ['id']); return new Response(body, { headers: { 'content-type': 'text/csv' } }); }",
    "const line = row.map(toCsvCell).join(',');",
    "const ids = list.join(',');",
    "const header = ['id', 'name'].join(','); const type = 'text/csv';",
    "const lines = rows.map((r) => [toCsvCell(r.a), toCsvCell(r.b)].join(',')).join('\\n');",
    'const lines = rows.map((r) => `${toCsvCell(r.a)},${toCsvCell(r.b)}`).join("\\n");',
    "function GET(body) { return new Response(body, { headers: { 'content-type': 'application/json' } }); }",
  ],
  invalid: [
    { code: "const body = rows.map((r) => [r.a, r.b].join(',')).join('\\n');", errors: [{ messageId: 'join' }] },
    { code: 'const body = rows.map((r) => `${r.a},${r.b}`).join("\\r\\n");', errors: [{ messageId: 'template' }] },
    {
      code: "function GET(rows) { const body = rows.join('\\n'); return new Response(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8' } }); }",
      errors: [{ messageId: 'response' }],
    },
    { code: "const type = 'text/csv'; const line = [name, '=1'].join(';');", errors: [{ messageId: 'join' }] },
    { code: "const file = 'tenants.csv'; const cells = [a, b]; const line = cells.join('\\t');", errors: [{ messageId: 'join' }] },
    { code: "const line = rows.map((r) => r.map((c) => String(c)).join(',')).join('\\r\\n');", errors: [{ messageId: 'join' }] },
  ],
});
