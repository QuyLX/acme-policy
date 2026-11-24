// Break-glass decision (FE §11.8, SC-16). Two distinct logins, 24h, no control file.
import { matchesAny } from './glob.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @returns {{ allow: true } | { allow: false, reason: string }}
 */
export function evaluateBreakGlass(record, { changedPaths, controlGlobs, now }) {
  const actors = record.activatedBy ?? [];
  if (actors.length !== 2 || actors[0] === actors[1]) return { allow: false, reason: 'two distinct logins are required' };
  const activated = Date.parse(record.activatedAt);
  const expires = Date.parse(record.expiresAt);
  if (!Number.isFinite(activated) || !Number.isFinite(expires)) return { allow: false, reason: 'activatedAt and expiresAt must be timestamps' };
  if (expires - activated > DAY_MS || expires <= now) return { allow: false, reason: 'the window is longer than 24 hours or already expired' };
  const paths = changedPaths ?? record.paths ?? [];
  if (paths.some((path) => matchesAny(path, controlGlobs))) return { allow: false, reason: 'a control file cannot use break-glass' };
  if (!paths.length) return { allow: false, reason: 'no path in scope' };
  return { allow: true };
}
