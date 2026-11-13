// The boot snapshot (GET /api/boot, added by the Rust core): the reads the window makes
// before it can draw itself, in one answer that index.html asks for while the bundle
// loads (window.__EOS_BOOT). Each part is what its own route answers, keyed by the path
// the dashboard asks it at; a request for that path takes it once, until the live
// stream is up. Without a snapshot (an older daemon, a failed request) every store asks
// its own route, as before.
//
// Not in ROUTES: that table mirrors contracts/src/http.ts, which has no such route.
export const BOOT_ROUTE = "/api/boot";

let parts = null; // path → { status, body }
let hello = null;

// Waits for the snapshot index.html asked for → whether there is one.
export async function receiveBoot(pending = typeof window !== "undefined" ? window.__EOS_BOOT : undefined) {
  if (!pending) return false;
  let snapshot = null;
  try { snapshot = await pending; } catch { /* the stores ask their routes */ }
  if (!snapshot || typeof snapshot !== "object" || !snapshot.parts || typeof snapshot.parts !== "object") return false;
  parts = new Map(Object.entries(snapshot.parts));
  hello = snapshot.hello ?? null;
  return true;
}

// The answer for `path` as fetchJson gives it ({ ok, status, body }), once; null when
// the snapshot has none (or carried an error: the store asks for itself).
export function takeBootPart(path) {
  const part = parts?.get(path);
  if (!part) return null;
  parts.delete(path);
  if (!(part.status >= 200 && part.status < 300)) return null;
  return { ok: true, status: part.status, body: part.body };
}

// The body of the answer for `path`, left for the request that takes it; undefined when
// the snapshot has none. For a first render that draws what that request will get.
export function peekBootPart(path) {
  const part = parts?.get(path);
  return part && part.status >= 200 && part.status < 300 ? part.body : undefined;
}

// The chat whose newest page the snapshot holds, if any.
export function bootPageChat() {
  for (const path of parts?.keys() ?? []) {
    const m = /^\/workers\/([^/?]+)\/events\?/.exec(path);
    if (m) return m[1];
  }
  return null;
}

// Whether the snapshot still stands (the live stream has not taken over yet).
export function bootActive() {
  return parts !== null;
}

// Where the stream stood when the parts were read ({ epoch, seq, caps }), once: a stream
// opened from it replays every change the parts may not show.
export function takeBootHello() {
  const h = hello;
  hello = null;
  return h;
}

// The live stream took over: what is left of the snapshot would be stale.
export function endBoot() {
  parts = null;
  hello = null;
}
