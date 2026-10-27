import { api } from "../api/client.js";

// Whether paths exist, asked of the daemon (/fs/stat) and remembered. A fresh
// answer is reused; an older one is still served at once (knownStat) so a
// remounted message draws its links without waiting, while the next ask
// refreshes it — a file created a moment later still gets its link.
const FRESH_MS = 5000;
const MAX_ENTRIES = 2000;
const known = new Map(); // abs → { at, stat: FsStat | null, pending?: Promise }

// The last answer for `abs`: its stat, null (does not exist) or undefined
// (never asked).
export function knownStat(abs) {
  return known.get(abs)?.stat;
}

export function isFresh(abs) {
  const hit = known.get(abs);
  return hit != null && hit.stat !== undefined && Date.now() - hit.at < FRESH_MS;
}

// → Promise<FsStat | null | undefined>; one ask per path in flight. Only a 404
// means "does not exist" — an unreachable daemon leaves the answer unknown.
export function statPath(abs) {
  const hit = known.get(abs);
  if (hit?.pending) return hit.pending;
  if (hit && isFresh(abs)) return Promise.resolve(hit.stat);
  if (known.size > MAX_ENTRIES) known.clear();
  const pending = api.statPath(abs).then(
    (s) => s,
    (e) => (/→ 404$/.test(e instanceof Error ? e.message : String(e)) ? null : undefined),
  ).then((stat) => {
    if (stat !== undefined) known.set(abs, { at: Date.now(), stat });
    else if (hit?.stat !== undefined) known.set(abs, { at: hit.at, stat: hit.stat });
    else known.delete(abs);
    return stat === undefined ? hit?.stat : stat;
  });
  known.set(abs, { at: hit?.at ?? 0, stat: hit?.stat, pending });
  return pending;
}
