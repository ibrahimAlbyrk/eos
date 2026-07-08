// Filesystem-change fan-out — the single channel for "a watched dir's contents
// changed on disk." useLive translates each SSE fs:change into emitFsChange(payload)
// while KEEPING its existing explorer.reconcileFsChange call: the Files-tab explorer
// and the code-view fileWatchStore are two independent consumers of the same event.
// Mirrors gitChangeBus's module-pub/sub idiom; the payload ({ changes:[{kind,path,
// dir,ts}] }) is passed through untouched so each consumer keys off it however it needs.

const subs = new Set(); // Set<handler(payload)>

// Subscribe to raw fs:change payloads. `cb` receives the full payload on every
// event; the consumer does its own path/dir dispatch. Returns an unsubscribe.
export function subscribeFsChange(cb) {
  subs.add(cb);
  return () => subs.delete(cb);
}

export function emitFsChange(payload) {
  for (const handler of [...subs]) handler(payload);
}
