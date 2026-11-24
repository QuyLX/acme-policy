// meta.override-direction — classifies every change to factory.config.yaml as tighten | neutral | loosen
// (FE §8.7 item 3; tech-design 03-presets §5). A loosening is a BLOCKER finding gated by approval: policy.risk (M2)
// turns it into R3; until then it is reported like a control-file change.
import { checkResult } from '../../lib/result.mjs';

const RANK = { off: 0, warn: 1, error: 2 };
const sev = (v) => RANK[Array.isArray(v) ? v[0] : v];
const json = (v) => JSON.stringify(v ?? null);

/** @returns {Array<{ direction: 'tighten'|'neutral'|'loosen', location: string, message: string }>} */
export function classifyConfigChange(base, head) {
  const out = [];
  const add = (direction, location, message) => out.push({ direction, location, message });
  const bp = base?.projects ?? {};
  const hp = head?.projects ?? {};
  for (const name of new Set([...Object.keys(bp), ...Object.keys(hp)])) {
    const b = bp[name];
    const h = hp[name];
    const at = (path) => `projects.${name}${path ? `.${path}` : ''}`;
    if (!h) { add('loosen', at(), 'project removed: its checks no longer run'); continue; }
    if (!b) { add('neutral', at(), 'project added'); }
    const bb = b ?? { kind: h.kind };
    if (bb.kind !== h.kind) add('loosen', at('kind'), `kind ${bb.kind} → ${h.kind}: preset rules may be dropped`);

    const br = bb.lint?.rules ?? {};
    const hr = h.lint?.rules ?? {};
    for (const rule of new Set([...Object.keys(br), ...Object.keys(hr)])) {
      const loc = at(`lint.rules.${rule}`);
      if (!(rule in hr)) add(sev(br[rule]) === 0 ? 'tighten' : 'loosen', loc, `rule override removed (was ${json(br[rule])})`);
      else if (!(rule in br)) add(sev(hr[rule]) === 0 ? 'loosen' : 'tighten', loc, `rule set to ${json(hr[rule])}`);
      else if (sev(hr[rule]) < sev(br[rule])) add('loosen', loc, `severity lowered ${json(br[rule])} → ${json(hr[rule])}`);
      else if (sev(hr[rule]) > sev(br[rule])) add('tighten', loc, `severity raised ${json(br[rule])} → ${json(hr[rule])}`);
      else if (json(hr[rule]) !== json(br[rule])) add('neutral', loc, 'rule options changed');
    }
    const listDiff = (path, bl = [], hl = [], addedDir, removedDir, what) => {
      for (const v of hl) if (!bl.includes(v)) add(addedDir, at(path), `${what} added: ${v}`);
      for (const v of bl) if (!hl.includes(v)) add(removedDir, at(path), `${what} removed: ${v}`);
    };
    listDiff('lint.ignores', bb.lint?.ignores, h.lint?.ignores, 'loosen', 'tighten', 'lint ignore');
    listDiff('typescript.extraInclude', bb.typescript?.extraInclude, h.typescript?.extraInclude, 'tighten', 'loosen', 'type-checked path');
    if (json(bb.typescript?.types) !== json(h.typescript?.types)) add('neutral', at('typescript.types'), 'ambient types changed');
    if (json(bb.typescript?.paths) !== json(h.typescript?.paths)) add('neutral', at('typescript.paths'), 'path aliases changed');
    if (json(bb.test?.environment) !== json(h.test?.environment)) add('neutral', at('test.environment'), 'test environment changed');
    if (json(bb.test?.conditions) !== json(h.test?.conditions)) add('neutral', at('test.conditions'), 'test resolution conditions changed');
    if (json(bb.test?.setupFiles) !== json(h.test?.setupFiles)) add('neutral', at('test.setupFiles'), 'setup files changed (they are control files themselves)');
    if (bb.test && !h.test) add('loosen', at('test'), 'tests no longer run for this project');
    if (bb.test?.browser && !h.test?.browser) add('loosen', at('test.browser'), 'real-browser lanes no longer run');
    else if (!bb.test?.browser && h.test?.browser) add('tighten', at('test.browser'), 'real-browser lanes enabled');
    if (bb.test?.browser?.visual && !h.test?.browser?.visual) add('loosen', at('test.browser.visual'), 'visual regression no longer runs');
    else if (!bb.test?.browser?.visual && h.test?.browser?.visual) add('tighten', at('test.browser.visual'), 'visual regression enabled');
    if (bb.publicApi && !h.publicApi) add('loosen', at('publicApi'), 'public API is no longer tracked (compatibility and changelog checks stop)');
    else if (!bb.publicApi && h.publicApi) add('tighten', at('publicApi'), 'public API is now tracked');
    else if (bb.publicApi && h.publicApi) {
      const bk = bb.publicApi.budgetKb;
      const hk = h.publicApi.budgetKb;
      if (bk !== hk) add(hk === undefined || (bk !== undefined && hk > bk) ? 'loosen' : 'tighten', at('publicApi.budgetKb'), `bundle budget ${bk ?? 'none'} → ${hk ?? 'none'} kB`);
      if (bb.publicApi.entry !== h.publicApi.entry || bb.publicApi.snapshot !== h.publicApi.snapshot) add('neutral', at('publicApi'), 'public API entry or snapshot path changed');
    }
    const bl = bb.test?.coverage?.lines;
    const hl = h.test?.coverage?.lines;
    if (bl !== hl) add(hl === undefined || (bl !== undefined && hl < bl) ? 'loosen' : 'tighten', at('test.coverage.lines'), `coverage threshold ${bl ?? 'none'} → ${hl ?? 'none'}`);
    const key = (e) => `${e.rule}@${e.file}`;
    const bBase = new Map((bb.baseline ?? []).map((e) => [key(e), e.count]));
    const hBase = new Map((h.baseline ?? []).map((e) => [key(e), e.count]));
    for (const [k, count] of hBase) {
      if (!bBase.has(k)) add('loosen', at('baseline'), `baseline entry added: ${k} ×${count} (existing violations accepted)`);
      else if (count > bBase.get(k)) add('loosen', at('baseline'), `baseline raised: ${k} ${bBase.get(k)} → ${count}`);
      else if (count < bBase.get(k)) add('tighten', at('baseline'), `baseline ratcheted down: ${k} ${bBase.get(k)} → ${count}`);
    }
    for (const k of bBase.keys()) if (!hBase.has(k)) add('tighten', at('baseline'), `baseline entry removed: ${k}`);
  }
  return out;
}

export function overrideDirectionCheck(def, base, head) {
  const started = Date.now();
  const changes = classifyConfigChange(base, head);
  const direction = changes.some((c) => c.direction === 'loosen') ? 'loosen' : changes.some((c) => c.direction === 'tighten') ? 'tighten' : 'neutral';
  return checkResult(def, {
    status: 'PASS',
    findings: changes.map((c) => ({
      source: 'check',
      ruleId: `config.${c.direction === 'loosen' ? 'loosening' : c.direction === 'tighten' ? 'tightening' : 'neutral'}`,
      severity: c.direction === 'loosen' ? 'BLOCKER' : 'INFO',
      location: `factory.config.yaml#${c.location}`,
      message: c.direction === 'loosen' ? `${c.message} — loosening: High tier (R3), needs a code owner of factory.config.yaml` : c.message,
      state: 'open',
    })),
    durationMs: Date.now() - started,
    extensions: { 'x-direction': direction },
  });
}
