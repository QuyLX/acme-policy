// Maps a create-instance long-running operation to the status the instance list shows (synthetic fixture, SC-19).
// Incident INC-7 (simulated): instances whose create operation failed were shown as RUNNING.

/** @param {{ done: boolean, error?: { code: string }, response?: { status: string } }} op */
export function instanceStatus(op) {
  if (!op.done) return 'PROVISIONING';
  return op.response?.status ?? 'RUNNING';
}
