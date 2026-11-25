// Profile-layer resolution with a resolution trace (Standard §7.3 items 6, 10-16; Standard Appendix K.2
// ProfileResolution; FE §8.3 "Resolve" items 2-5; FE Appendix A). SC-21 / CORE-VER-13.
//   - Layers, general → specific: core, domain, organization, repository, surface, task-class, risk, task (item 10).
//   - Merge per check: requirement takes the max, when takes OR, gate takes the earlier gate, ordered parameters take
//     the stricter value, set-valued parameters take the union (item 6). A more specific layer that tries to loosen
//     is rejected and never merged (item 13; table row "One layer tries to loosen another").
//   - Incomparable values (two runtime pins, two exclusive parameters): resolution fails and the task moves to BLOCKED
//     with a conflict record, unless a versioned resolution entry in the more specific profile decides it (item 15).
//     Until blocking is enabled (FE §8.3 item 4: Phase 2 or 2027-04-01, whichever comes first) the conflict is a
//     warning and the plan provisionally uses the value of the more specific layer, marked provisional in the trace.
//     The switch is the gate's own policy: it comes from the clock and the registry entry of profile.resolve
//     (`params.blockingIncomparableFrom`, `params.phase2Since`), never from the request. A request that carries
//     `blockingIncomparable`, `at` or `now` is reported (profile.request-switch-ignored) and the fields are ignored.
//     The clock is injectable only as a code option (tests, the showcase harness), never through the input file.
//   - The trace (layers + versions, conflicts and how each was resolved) goes into the evidence (item 16).
// Parameter forms: { exact: v } (incomparable when different), { min: n } (higher is stricter), { max: n } (lower is
// stricter), { set: [..] } (union). A plain scalar is `exact`, a plain array is `set`.
import { readYaml, policyPath } from './io.mjs';
import { validate } from './schema.mjs';
import { checkResult } from './result.mjs';

export const LAYERS = ['core', 'domain', 'organization', 'repository', 'surface', 'task-class', 'risk', 'task'];
export const BLOCKING_INCOMPARABLE_FROM = '2027-04-01'; // FE §8.3 item 4; Standard §20 CORE-VER-13 "from 2027-04-01"
const REQUIREMENT = { optional: 0, advisory: 1, required: 2 };
const GATE = { 'post-release': 0, publish: 1, merge: 2 }; // the earlier gate is the stricter one

const kindOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v)[0] : Array.isArray(v) ? 'set' : 'exact');
const valueOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.values(v)[0] : v);
const norm = (v) => ({ [kindOf(v)]: valueOf(v) });

/** Fields of a profile.resolve request that try to set the blocking switch; the gate ignores them (FE §8.3 item 4). */
export const REQUEST_SWITCH_FIELDS = ['blockingIncomparable', 'at', 'now'];

/**
 * True when blocking resolution is in force at the clock `now` (FE §8.3 item 4): from the switch date, or from the
 * date Phase 2 started when the policy records one (`phase2Since`), whichever comes first. `now` defaults to the real
 * clock; only code (tests, the showcase harness) passes another value.
 */
export function blockingIncomparableAt(now, from = BLOCKING_INCOMPARABLE_FROM, phase2Since = null) {
  const day = String(now ?? new Date().toISOString()).slice(0, 10);
  return day >= from || Boolean(phase2Since && day >= String(phase2Since).slice(0, 10));
}

/** Loads a layer from a policy-relative path, or returns an inline layer. Validates against schemas/profile-layer. */
export function loadLayer(ref) {
  const layer = typeof ref === 'string' ? readYaml(policyPath(ref)) : ref;
  const errors = validate('profile-layer', layer);
  if (errors.length) throw new Error(`profile layer ${typeof ref === 'string' ? ref : layer?.id}: ${errors.join('; ')}`);
  return layer;
}

/**
 * @param {object[]} layers ProfileLayer[] in order general → specific
 * @param {{ blockingIncomparable?: boolean, now?: string, registry?: object[] }} [opts] code options only: an explicit
 *   switch for library callers and tests, or the clock `now` (default: the real clock)
 * @returns {{ ok: boolean, blocked: boolean, plan: Record<string, object>, findings: object[],
 *             resolution: { layers: object[], conflicts: object[] }, trace: object[] }}
 */
export function resolveProfiles(layers, opts = {}) {
  const blocking = opts.blockingIncomparable ?? blockingIncomparableAt(opts.now);
  const findings = [];
  const conflicts = [];
  const trace = [];
  const plan = {};
  const f = (ruleId, severity, location, message) => findings.push({ source: 'check', ruleId, severity, location, message, state: 'open' });
  let blocked = false;

  let last = -1;
  for (const p of layers) {
    const i = LAYERS.indexOf(p.layer);
    if (i < 0) throw new Error(`unknown profile layer ${p.layer} (Standard §7.3 item 10)`);
    if (i < last) throw new Error(`profile layer ${p.layer} (${p.id}) is out of order: layers go from general to specific (Standard §7.3 item 10)`);
    last = i;
  }
  const at = (p) => `${p.layer}:${p.id}@${p.version}`;

  /** A versioned resolution entry in a profile at least as specific as the later layer, decided by both owners. */
  const decisionFor = (checkId, parameter, earlier, later) => {
    const from = layers.indexOf(later);
    for (const p of layers.slice(from)) {
      const d = (p.resolutions ?? []).find((r) => r.checkId === checkId && r.parameter === parameter);
      if (!d) continue;
      const owners = [earlier.owner, later.owner].filter(Boolean);
      const missing = owners.filter((o) => !d.decidedBy.includes(o));
      if (missing.length) {
        f('profile.decision-incomplete', 'WARNING', `${checkId}.${parameter}`, `resolution ${d.decisionRef} in ${at(p)} lacks the decision of profile owner(s) ${missing.join(', ')} (Standard §7.3 item 15)`);
        continue;
      }
      return { ...d, in: p };
    }
    return null;
  };

  for (const p of layers) {
    for (const c of p.checks ?? []) {
      const cur = plan[c.id];
      if (!cur) {
        plan[c.id] = { requirement: c.requirement ?? 'optional', when: c.when ?? 'true', gate: c.gate ?? 'merge', params: Object.fromEntries(Object.entries(c.params ?? {}).map(([k, v]) => [k, norm(v)])), source: Object.fromEntries(Object.keys(c.params ?? {}).map((k) => [k, p])), requirementFrom: p, gateFrom: p };
        trace.push({ layer: p.layer, id: p.id, version: p.version, checkId: c.id, rule: 'added' });
        continue;
      }
      for (const [field, order] of [['requirement', REQUIREMENT], ['gate', GATE]]) {
        if (c[field] === undefined || c[field] === cur[field]) continue;
        const values = [cur[field], c[field]];
        if (order[c[field]] > order[cur[field]]) {
          cur[field] = c[field];
          conflicts.push({ checkId: c.id, parameter: field, values, resolvedBy: 'stricter' });
          trace.push({ layer: p.layer, id: p.id, version: p.version, checkId: c.id, rule: 'stricter', parameter: field });
        } else {
          conflicts.push({ checkId: c.id, parameter: field, values, resolvedBy: 'rejected' });
          trace.push({ layer: p.layer, id: p.id, version: p.version, checkId: c.id, rule: 'rejected', parameter: field });
          f('profile.loosening-rejected', 'WARNING', c.id, `${at(p)} tries to loosen ${field} of ${c.id} (${values[0]} → ${values[1]}): rejected, never merged (Standard §7.3 item 13)`);
        }
      }
      if (c.when && c.when !== cur.when) cur.when = cur.when === 'true' || c.when === 'true' ? 'true' : `(${cur.when}) OR (${c.when})`;
      for (const [k, raw] of Object.entries(c.params ?? {})) {
        const next = norm(raw);
        const prev = cur.params[k];
        if (!prev) {
          cur.params[k] = next;
          cur.source[k] = p;
          continue;
        }
        const pk = kindOf(prev);
        const nk = kindOf(next);
        const pv = valueOf(prev);
        const nv = valueOf(next);
        const values = [pv, nv];
        const record = (rule, extra = {}) => {
          conflicts.push({ checkId: c.id, parameter: k, values, resolvedBy: rule, ...extra });
          trace.push({ layer: p.layer, id: p.id, version: p.version, checkId: c.id, rule: extra['x-fe']?.state ?? rule, parameter: k });
        };
        if (pk === nk && pk === 'set') {
          const union = [...new Set([...pv, ...nv])];
          if (union.length !== pv.length) record('union');
          cur.params[k] = { set: union };
          continue;
        }
        if (pk === nk && (pk === 'min' || pk === 'max')) {
          if (pv === nv) continue;
          const stricter = pk === 'min' ? nv > pv : nv < pv;
          if (stricter) {
            cur.params[k] = next;
            cur.source[k] = p;
            record('stricter');
          } else {
            record('rejected');
            f('profile.loosening-rejected', 'WARNING', `${c.id}.${k}`, `${at(p)} tries to loosen ${c.id}.${k} (${pk} ${pv} → ${nv}): rejected, never merged (Standard §7.3 item 13)`);
          }
          continue;
        }
        if (pk === nk && JSON.stringify(pv) === JSON.stringify(nv)) continue;
        // Incomparable: two exact values, or two parameter forms that cannot both hold (Standard §7.3 item 15).
        const earlier = cur.source[k];
        const d = decisionFor(c.id, k, earlier, p);
        if (d) {
          cur.params[k] = norm(d.value);
          cur.source[k] = d.in;
          record('decision', { decisionRef: d.decisionRef });
          f('profile.conflict-decided', 'INFO', `${c.id}.${k}`, `incomparable ${c.id}.${k} (${JSON.stringify(values)}) resolved to ${JSON.stringify(d.value)} by ${d.decisionRef}, decided by ${d.decidedBy.join(', ')} (Standard §7.3 item 15)`);
        } else if (blocking) {
          blocked = true;
          record('rejected', { 'x-fe': { state: 'blocked', layers: [at(earlier), at(p)], owners: [earlier.owner, p.owner].filter(Boolean) } });
          f('profile.conflict-incomparable', 'BLOCKER', `${c.id}.${k}`, `incomparable ${c.id}.${k}: ${at(earlier)} = ${JSON.stringify(pv)}, ${at(p)} = ${JSON.stringify(nv)}. Resolution fails and the task moves to BLOCKED; the owners (${[earlier.owner, p.owner].filter(Boolean).join(', ')}) decide in a versioned resolution entry of the more specific profile or an ADR (Standard §7.3 items 6, 15)`);
        } else {
          cur.params[k] = next;
          cur.source[k] = p;
          record('rejected', { 'x-fe': { state: 'provisional', value: nv, from: at(p), owners: [earlier.owner, p.owner].filter(Boolean) } });
          f('profile.conflict-provisional', 'WARNING', `${c.id}.${k}`, `incomparable ${c.id}.${k}: ${at(earlier)} = ${JSON.stringify(pv)}, ${at(p)} = ${JSON.stringify(nv)}. Before blocking resolution is enabled (FE §8.3 item 4) the plan provisionally uses ${JSON.stringify(nv)} from the more specific layer; the owners must record a decision`);
        }
      }
    }
  }

  if (opts.registry) {
    for (const [id, e] of Object.entries(plan)) {
      const lc = opts.registry.find((r) => r.checkId === id)?.lifecycle;
      if (lc === 'planned' || lc === 'deprecated') delete plan[id]; // Standard §7.3 item 7
      else if (lc === 'shadow') e.enforcement = 'observe';
    }
  }
  const out = Object.fromEntries(Object.entries(plan).map(([id, e]) => [id, { requirement: e.requirement, when: e.when, gate: e.gate, params: e.params, ...(e.enforcement ? { enforcement: e.enforcement } : {}) }]));
  return {
    ok: !blocked,
    blocked,
    blockingIncomparable: blocking,
    plan: out,
    findings,
    resolution: { layers: layers.map((p) => ({ layer: p.layer, id: p.id, version: p.version })), conflicts },
    trace,
  };
}

/**
 * profile.resolve: resolves the layers of an input and reports conflicts with the resolution trace in `x-resolution`.
 * input: { layers: Array<path | ProfileLayer> } — the request names the layers, nothing else. The blocking switch is
 * the gate's policy (FE §8.3 item 4): the clock against `params.blockingIncomparableFrom` and `params.phase2Since` of
 * the registry entry. `opts.now` is the clock, a code option for tests and the showcase harness; the request cannot set
 * it. While blocking is on, the check runs at its target enforcement (blocking): an incomparable conflict FAILs and the
 * task moves to BLOCKED.
 * @param {object} def registry entry of profile.resolve
 * @param {{ layers: Array<string | object> }} input
 * @param {{ now?: string }} [opts]
 */
export function profileResolveCheck(def, input, opts = {}) {
  const started = Date.now();
  const now = opts.now ?? new Date().toISOString();
  const from = def.params?.blockingIncomparableFrom ?? BLOCKING_INCOMPARABLE_FROM;
  const phase2Since = def.params?.phase2Since ?? null;
  const blocking = blockingIncomparableAt(now, from, phase2Since);
  const effective = blocking ? { ...def, enforcement: def.targetEnforcement ?? 'blocking' } : def;
  const r = resolveProfiles(input.layers.map(loadLayer), { blockingIncomparable: blocking });
  const ignored = REQUEST_SWITCH_FIELDS.filter((k) => Object.hasOwn(input, k));
  const findings = [
    ...(ignored.length
      ? [{ source: 'check', ruleId: 'profile.request-switch-ignored', severity: 'WARNING', location: ignored.join(', '), message: `the request sets ${ignored.map((k) => `${k}: ${JSON.stringify(input[k])}`).join(', ')}; the blocking switch is the gate's policy (clock ${now.slice(0, 10)}, from ${from}${phase2Since ? `, Phase 2 since ${phase2Since}` : ''}), so these fields are ignored (FE §8.3 item 4)`, state: 'open' }]
      : []),
    ...r.findings,
  ];
  const status = r.blocked && effective.enforcement === 'blocking' ? 'FAIL' : 'PASS';
  return {
    result: checkResult(effective, {
      status,
      reason: status === 'FAIL' ? `resolution failed: ${r.findings.filter((f) => f.severity === 'BLOCKER').map((f) => f.location).join(', ')} incomparable (Standard §7.3 items 6, 15)` : undefined,
      findings,
      durationMs: Date.now() - started,
      extensions: { 'x-resolution': r.resolution, 'x-plan': r.plan, 'x-blocking-incomparable': blocking, 'x-blocking-switch': { now, from, phase2Since, blocking } },
    }),
    resolution: r,
  };
}

/**
 * The resolution part of a VerificationRun (Standard Appendix K.2 ProfileResolution; FE §8.3 item 5): when
 * profile.resolve is among the checks, its trace becomes `run.resolution` and the resolved layers `resolvedProfiles`.
 * Used by `acme-policy run` (bin/acme-policy.mjs commandRun) and by the SC-21 showcase kind.
 * @param {object[]} checks CheckResult[]
 * @returns {{ resolvedProfiles?: Array<{ id: string, version: string }>, resolution?: { layers: object[], conflicts: object[] } }}
 */
export function resolutionEvidence(checks) {
  const resolution = checks.find((c) => c.checkId === 'profile.resolve')?.extensions?.['x-resolution'];
  if (!resolution) return {};
  return { resolvedProfiles: resolution.layers.map(({ id, version }) => ({ id, version })), resolution };
}
