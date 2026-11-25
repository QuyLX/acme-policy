// Circuit breakers for autonomy (CORE-GOV-07, CORE-GOV-08; Standard §9.9 items 1-7; FE §10.6; FE §19.4).
// Breakers are tracked per surface (the Standard's "area") and per task class. They tighten automatically from signals
// and loosen only by a human decision with evidence by the surface owner AND the Factory owner (§9.9 item 3, §9.10).
// RECORDED signals: no production telemetry exists; the signal log is a fixture. The state is a BreakerState
// (schemas/breaker-state.schema.json). Nothing here enables A0: it is forbidden in pilot mode (§20.8 item 4.7).

/** Effects of a tripped breaker, by signal (§9.9 item 2 table; FE §10.6). */
export const EFFECTS = {
  'zero-human-revert': ['pause-a0', 'signoff-not-counted'],
  'revert-rate': ['pause-a0', 'signoff-not-counted'],
  'early-indicators': ['pause-a0', 'signoff-not-counted'],
  'escaped-defect': ['trust-to-t0', 're-evaluation', 'signoff-not-counted'],
  'error-budget': ['pause-a0', 'signoff-not-counted'],
  'break-glass': ['pause-a0', 'signoff-not-counted'],
  'version-change': ['re-evaluation'],
  'harmful-review': ['pin-reviewer', 'disable-auto-fix'],
  'policy-violation': ['revoke-agent-scopes'],
};

const EARLY = ['hotfix-48h', 'post-merge-check-failure', 'shepherd-pause'];

/**
 * Applies signals to a breaker state. Tightening only: a signal can trip a breaker, never close one.
 * @param {{ breakers: object[] }} state
 * @param {object[]} signals recorded signals { kind, surface?, taskClass?, mergedVia?, at, ... }
 * @param {{ windowDays: number, minSample: number, revertRateMax: number, earlyIndicatorsToPause: number }} policy
 * @param {{ changesInWindow?: Record<string, number>, now: string }} ctx changes per surface in the window (rate denominator)
 */
export function applySignals(state, signals, policy, { changesInWindow = {}, now }) {
  const breakers = state.breakers.map((b) => ({ ...b }));
  const tripped = [];
  const nowMs = Date.parse(now);
  const recent = signals.filter((s) => nowMs - Date.parse(s.at) <= policy.windowDays * 86400000 && Date.parse(s.at) <= nowMs);
  const trip = (scope, signal, reason, at) => {
    let b = breakers.find((x) => x.scope.kind === scope.kind && x.scope.id === scope.id && x.signal === signal);
    if (!b) breakers.push((b = { id: `${scope.kind}:${scope.id}:${signal}`, scope, signal, state: 'closed' }));
    if (b.state === 'tripped') return;
    Object.assign(b, { state: 'tripped', trippedAt: at, reason, effects: EFFECTS[signal], trippedBy: 'automatic' });
    tripped.push(b.id);
  };
  const bySurface = new Map();
  for (const s of recent) if (s.surface) bySurface.set(s.surface, [...(bySurface.get(s.surface) ?? []), s]);
  for (const [surface, list] of bySurface) {
    const reverts = list.filter((s) => s.kind === 'revert');
    // §9.9 item 5 + FE §10.6: any revert of a zero-human (A0) merge is an absolute trigger at low volume.
    const a0Revert = reverts.find((s) => s.mergedVia === 'A0');
    if (a0Revert) trip({ kind: 'surface', id: surface }, 'zero-human-revert', `revert of A0 merge ${a0Revert.change}: A0 paused until a human reviews`, a0Revert.at);
    const n = changesInWindow[surface] ?? 0;
    if (n >= policy.minSample && reverts.length / n > policy.revertRateMax) trip({ kind: 'surface', id: surface }, 'revert-rate', `revert rate ${reverts.length}/${n} > ${policy.revertRateMax}`, reverts.at(-1).at);
    // §9.9 item 6 + FE §10.6: early indicators count in the rate; two within the window pause A0.
    const early = list.filter((s) => EARLY.includes(s.kind));
    if (early.length >= policy.earlyIndicatorsToPause) trip({ kind: 'surface', id: surface }, 'early-indicators', `${early.length} early indicators (${early.map((e) => e.kind).join(', ')})`, early.at(-1).at);
    const budget = list.find((s) => s.kind === 'error-budget-exhausted');
    if (budget) trip({ kind: 'surface', id: surface }, 'error-budget', `error budget of ${surface} exhausted (FE §19.4): A0 closed until it recovers`, budget.at);
    const bg = list.find((s) => s.kind === 'break-glass');
    if (bg) trip({ kind: 'surface', id: surface }, 'break-glass', 'break-glass used: A0 closed until post-incident verification', bg.at);
  }
  for (const s of recent) {
    if (s.kind === 'escaped-defect' && s.taskClass && s.confirmedBy) trip({ kind: 'taskClass', id: s.taskClass }, 'escaped-defect', `escaped defect ${s.incident ?? ''} attributed to ${s.taskClass}, confirmed by ${s.confirmedBy}`.replace('  ', ' '), s.at);
    // §9.9 item 7: a defect that cannot be attributed counts against the area, never the task class.
    if (s.kind === 'escaped-defect' && (!s.taskClass || !s.confirmedBy) && s.surface) trip({ kind: 'surface', id: s.surface }, 'revert-rate', 'unattributed escaped defect counted against the surface', s.at);
    if (s.kind === 'version-change' && s.taskClass) trip({ kind: 'taskClass', id: s.taskClass }, 'version-change', `${s.what}: RE-EVALUATION_REQUIRED until evals pass`, s.at);
  }
  return { state: { ...state, breakers, updatedAt: now }, tripped };
}

/** Tripped breakers that apply to a change touching `surfaces` in `taskClass`. */
export function trippedFor(state, { surfaces = [], taskClass }) {
  return state.breakers.filter((b) => b.state === 'tripped' && ((b.scope.kind === 'surface' && surfaces.includes(b.scope.id)) || (b.scope.kind === 'taskClass' && b.scope.id === taskClass)));
}

/**
 * Loosening is never automatic (§9.9 item 3): it needs a human decision with evidence by the surface owner and the
 * Factory owner (§9.10; FE §10.6). Agents never decide.
 * @returns {{ state?: object, problems: string[] }}
 */
export function loosen(state, breakerId, { decidedBy = [], evidence, surfaceOwner, factoryOwner, at }) {
  const problems = [];
  const b = state.breakers.find((x) => x.id === breakerId);
  if (!b) problems.push(`no breaker ${breakerId}`);
  if (decidedBy.some((d) => d.startsWith('agent:'))) problems.push('an agent cannot loosen a breaker');
  if (!decidedBy.includes(surfaceOwner) || !decidedBy.includes(factoryOwner)) problems.push(`loosening needs ${surfaceOwner} and ${factoryOwner} (§9.10)`);
  if (!evidence) problems.push('loosening needs evidence (§9.9 item 3)');
  if (problems.length) return { problems };
  return { problems, state: { ...state, breakers: state.breakers.map((x) => (x.id === breakerId ? { ...x, state: 'closed', loosenedBy: decidedBy, loosenedAt: at, evidence } : x)) } };
}
