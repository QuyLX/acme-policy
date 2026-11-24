// GitHub webhook body → ChangeEvent → sod-input. The only module that reads a GitHub payload (10-ci-cd §2, §8).
import { matchesAny } from './glob.mjs';

const REVIEW_STATE = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented' };

function isAgent(login, agentLogins) {
  return Boolean(login) && (agentLogins.includes(login) || login.endsWith('[bot]'));
}

function matchesCodeowner(pattern, file) {
  if (pattern === '*') return true;
  const glob = pattern.endsWith('/') ? `${pattern}**` : pattern;
  return matchesAny(file, [glob]);
}

/** Last matching CODEOWNERS rule wins, per changed file. Logins are stored without '@'. */
export function areasFromCodeowners(text, files) {
  const rules = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const [pattern, ...owners] = line.split(/\s+/);
    return { pattern, owners: owners.map((owner) => owner.replace(/^@/, '')) };
  });
  const groups = new Map();
  const source = files.length ? files : ['*'];
  for (const file of source) {
    const rule = [...rules].reverse().find((item) => matchesCodeowner(item.pattern, file));
    const id = rule?.pattern ?? '*';
    if (!groups.has(id)) groups.set(id, rule?.owners ?? []);
  }
  return [...groups].map(([id, owners]) => ({ id, teamMembers: owners, codeOwners: owners }));
}

/** Ignores any Requested-by trailer. requester.id is the pull-request author, or null when the payload has no user. */
export function toChangeEvent(payload, { agentLogins = [] } = {}) {
  const pr = payload.pull_request ?? {};
  const login = pr.user?.login ?? null;
  const reviews = (payload.reviews ?? []).map((review) => ({
    by: review.user.login,
    commitSha: review.commit_id,
    state: REVIEW_STATE[review.state] ?? String(review.state).toLowerCase(),
    isAgent: isAgent(review.user.login, agentLogins),
  }));
  return {
    provider: 'github',
    workItemId: pr.base ? `${pr.base.repo.full_name}#${pr.number}` : 'unknown',
    headSha: pr.head?.sha ?? '',
    baseSha: pr.base?.sha ?? '',
    event: payload.review || payload.action === 'submitted' ? 'pull_request_review' : 'pull_request',
    actor: { id: payload.sender?.login ?? 'unknown', kind: isAgent(payload.sender?.login, agentLogins) ? 'agent' : 'human' },
    requester: login ? { id: login, source: 'ci-dispatch' } : { id: null, source: 'unknown' },
    author: login ?? 'unknown',
    pushers: login ? [login] : [],
    reviews,
    files: payload.files ?? [],
  };
}

/** areas come from CODEOWNERS. tier is the classified tier, never a value from the pull request. */
export function toSodInput(event, areas, { tier }) {
  const approvals = event.reviews
    .filter((review) => review.state === 'approved' && review.commitSha === event.headSha)
    .map(({ by, commitSha, isAgent: agent }) => ({ by, commitSha, isAgent: agent }));
  return {
    workItemId: event.workItemId,
    tier,
    headSha: event.headSha,
    requester: event.requester,
    requesterSignedOff: approvals.some((approval) => approval.by === event.requester.id),
    author: event.author,
    pushers: event.pushers,
    approvals,
    areas,
    controlFilesTouched: [],
  };
}
