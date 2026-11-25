// Knowledge gardening (Standard §5.8 items 7-12 and 18-19, §5.10 item 1 "the owner of an artifact is gone";
// FE §7.3; CORE-KNW-09). Automation may only flag suspicion: ACTIVE → NEEDS_REVALIDATION. Every other transition is a
// proposal for the artifact's authority. Validity is never inferred from age: age only opens a periodic review
// proposal and never changes a state.
import { validate } from './schema.mjs';

/** The only transition automation and agents may apply on their own (Standard §5.8 item 8). */
export function automationMayTransition(from, to) {
  return from === 'ACTIVE' && to === 'NEEDS_REVALIDATION';
}

/**
 * @param {Array<{ path: string, meta: object }>} records knowledge records (loadArtifacts)
 * @param {{ owners: string[], now: string, reviewAfterDays?: number, runId?: string }} o owners = identities and teams
 *        that still exist (from the ownership catalog)
 * @returns {{ transitions: object[], reconciliation: object[], proposals: object[], statuses: Record<string, { status: string, version: string }> }}
 */
export function gardenKnowledge(records, { owners, now, reviewAfterDays = 365, runId = 'gardening' }) {
  const known = new Set(owners);
  const transitions = [];
  const reconciliation = [];
  const proposals = [];
  const statuses = {};
  for (const { path, meta } of records) {
    let status = meta.status;
    const ref = `${meta.id}@${meta.version}`;
    if (meta.status === 'ACTIVE' && !known.has(meta.owner)) {
      if (!automationMayTransition(status, 'NEEDS_REVALIDATION')) throw new Error(`gardening may not move ${ref} from ${status}`);
      status = 'NEEDS_REVALIDATION';
      transitions.push({ artifact: ref, path, from: 'ACTIVE', to: 'NEEDS_REVALIDATION', reason: `owner ${meta.owner} is gone without a replacement (Standard §5.8 item 19)` });
      const record = {
        id: `REC-${runId}-${meta.id}`,
        trigger: { type: 'owner-removed', ref },
        // `review` needs the authority: gardening only proposes it and opens a work item (§5.10 items 6, 13).
        affected: [{ artifact: ref, relation: 'describes', decision: 'review', state: 'proposed', workItem: `assign an owner and revalidate ${meta.id}` }],
        activeTasksNotified: [],
      };
      const errors = validate('reconciliation-record', record);
      if (errors.length) throw new Error(`gardening produced an invalid ReconciliationRecord: ${errors.join('; ')}`);
      reconciliation.push(record);
    } else if (meta.status === 'ACTIVE' && meta.validatedAgainst?.at && (Date.parse(now) - Date.parse(meta.validatedAgainst.at)) / 864e5 > reviewAfterDays) {
      proposals.push({ artifact: ref, proposal: 'periodic-review', reason: `validated ${meta.validatedAgainst.at}; age only triggers review, the state stays ACTIVE (Standard §5.8 items 10-12)` });
    }
    statuses[meta.id] = { status, version: String(meta.version) };
  }
  return { transitions, reconciliation, proposals, statuses };
}
