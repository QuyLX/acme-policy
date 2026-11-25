// Synthetic tenant records (never production data). Two names are formula-injection probes.
export type TenantRow = { id: string; name: string; status: string; balance: number };

const TENANTS: TenantRow[] = [
  { id: 't-001', name: 'Northwind Synthetic', status: 'active', balance: 120 },
  { id: 't-002', name: '=HYPERLINK("https://attacker.invalid","open")', status: 'active', balance: -42.5 },
  { id: 't-003', name: '@SUM(1+1)', status: 'suspended', balance: 0 },
];

export function allTenants(): TenantRow[] {
  return TENANTS.map((t) => ({ ...t }));
}
