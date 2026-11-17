// How long a closed invoice's deposit is watched (spec story 57), and how
// long after that money already seen may still be routed.

export const WATCH_AFTER_CLOSE_MS = 7 * 24 * 60 * 60 * 1000;

// A payment first seen just before the watch ends may still need its
// confirmations, or a route that waits; after this, a person handles it.
export const ROUTE_GRACE_MS = 24 * 60 * 60 * 1000;

/** `watch_until` for an invoice that closed (expired, cancelled or completed) at `closedAt`. */
export function watchUntil(closedAt: number): number {
  return closedAt + WATCH_AFTER_CLOSE_MS;
}
