/**
 * The $push that logs a status change. It belongs in the same update that
 * changes the status, so a crash can't change one without the other: the
 * webhook pass announces each logged change (src/webhooks/webhook-pass.ts).
 */
export function logStatusChange(from: string, to: string, at: number) {
  return { $push: { status_log: { from, to, at } } };
}
