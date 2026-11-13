import { api } from "../api/client.js";

// Whether paths exist, asked of the daemon (/fs/stat) and remembered. A fresh
// answer is reused; an older one is still served at once (knownStat) so a
// remounted message draws its links without waiting, while the next ask
// refreshes it — a file created a moment later still gets its link.
//
// The asks of one frame go out together: a transcript's path chips (and the
// terminal's links) cost one POST /fs/stat, not one request per path. A daemon
// without that route is asked one path at a time.
const FRESH_MS = 5000;
const MAX_ENTRIES = 2000;
const FRAME_MS = 16;
// The daemon's bound on one batch.
const BATCH_MAX = 200;
const known = new Map(); // abs → { at, stat: FsStat | null, pending?: Promise }

let gathering = null; // abs → resolve, for the asks of this frame
let batchRoute = true;

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
  const pending = ask(abs).then((stat) => {
    if (stat !== undefined) known.set(abs, { at: Date.now(), stat });
    else if (hit?.stat !== undefined) known.set(abs, { at: hit.at, stat: hit.stat });
    else known.delete(abs);
    return stat === undefined ? hit?.stat : stat;
  });
  known.set(abs, { at: hit?.at ?? 0, stat: hit?.stat, pending });
  return pending;
}

// → the daemon's answer for `abs`: its stat, null (404) or undefined (unknown).
function ask(abs) {
  return new Promise((resolve) => {
    if (!gathering) {
      gathering = new Map();
      setTimeout(send, FRAME_MS);
    }
    gathering.set(abs, resolve);
  });
}

function send() {
  const asked = gathering;
  gathering = null;
  const paths = [...asked.keys()];
  for (let i = 0; i < paths.length; i += BATCH_MAX) {
    const chunk = paths.slice(i, i + BATCH_MAX);
    void statAll(chunk).then((answers) => chunk.forEach((abs, j) => asked.get(abs)(answers[j])));
  }
}

async function statAll(paths) {
  if (batchRoute && paths.length > 1) {
    let results;
    try {
      results = await api.statPaths(paths);
    } catch {
      return paths.map(() => undefined);
    }
    if (results) return paths.map((_, i) => answerOf(results[i]));
    batchRoute = false;
  }
  return Promise.all(paths.map(statOne));
}

function answerOf(result) {
  if (result?.status === 200) return result.body;
  return result?.status === 404 ? null : undefined;
}

function statOne(abs) {
  return api.statPath(abs).then(
    (s) => s,
    (e) => (/→ 404$/.test(e instanceof Error ? e.message : String(e)) ? null : undefined),
  );
}
