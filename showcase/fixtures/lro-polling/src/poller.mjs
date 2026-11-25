// LRO polling (FE §8.8: `state.lro-lifecycle` is a timing-sensitive area). Synthetic fixture for SC-06.
// Network latency runs on a virtual clock, so the race below is deterministic for a given seed: the same seed
// always gives the same interleaving, and stress mode (several seeds) reproduces it.

/** A virtual clock: callbacks run in time order (ties in scheduling order). */
export function createClock() {
  let now = 0;
  let seq = 0;
  const queue = [];
  return {
    get now() { return now; },
    at(t, fn) { queue.push({ t, fn, seq: seq++ }); },
    run() {
      while (queue.length) {
        queue.sort((a, b) => a.t - b.t || a.seq - b.seq);
        const next = queue.shift();
        now = next.t;
        next.fn();
      }
    },
  };
}

/** Latency in ms of the n-th poll response for a seed (deterministic jitter). */
export function latency(seed, n) {
  return [3, 8, 23, 5][(3 * seed + n) % 4];
}

/**
 * Polls an operation every `interval` ms, `polls` times, and keeps the operation state the UI shows.
 * `server(t)` returns the operation state when a request sent at t is handled.
 */
export function pollOperation({ clock, server, seed, interval = 10, polls = 3 }) {
  let state = 'PENDING';
  for (let n = 0; n < polls; n++) {
    const sentAt = n * interval;
    clock.at(sentAt, () => {
      const snapshot = server(sentAt);
      clock.at(sentAt + latency(seed, n), () => {
        state = snapshot; // applies responses in arrival order
      });
    });
  }
  return { get state() { return state; } };
}
