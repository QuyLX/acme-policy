// Bounded retry for idempotent reads.
export async function withRetry(fn, { attempts = 2 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}
