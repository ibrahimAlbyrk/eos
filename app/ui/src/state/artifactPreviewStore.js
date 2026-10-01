import { useCallback, useEffect, useSyncExternalStore } from "react";

// Artifact link previews. The Electron shell exposes window.eosArtifactPreview
// (preload) to render a published claude.ai page in Eos's own claude.ai session
// and hand back a JPEG. Absent in the plain web build → every preview is
// "unavailable" and the card keeps its glyph. Results are cached per URL so a
// second hover is instant; the shell caches on disk across restarts too.
const IDLE = Object.freeze({ state: "idle" });
const UNAVAILABLE = Object.freeze({ state: "unavailable" });

const mem = new Map(); // url -> { state, dataUrl? }
const inflight = new Map(); // url -> Promise
const listeners = new Map(); // url -> Set<fn>

const api = () => (typeof window !== "undefined" ? window.eosArtifactPreview : null);

function emit(url) {
  for (const fn of listeners.get(url) ?? []) fn();
}

function set(url, value) {
  mem.set(url, value);
  emit(url);
}

export function requestPreview(url) {
  if (!url || mem.has(url) || inflight.has(url)) return;
  const bridge = api();
  if (!bridge?.get) {
    mem.set(url, UNAVAILABLE);
    return;
  }
  const p = bridge
    .get(url)
    .then((r) => set(url, r?.dataUrl ? { state: "ready", dataUrl: r.dataUrl } : { state: r?.state ?? "error" }))
    .catch(() => set(url, { state: "error" }))
    .finally(() => inflight.delete(url));
  inflight.set(url, p);
}

// Open Eos's one-time claude.ai sign-in, then re-fetch anything that was blocked.
export async function connectClaude() {
  const bridge = api();
  if (!bridge?.connect) return false;
  const r = await bridge.connect().catch(() => ({ signedIn: false }));
  if (!r?.signedIn) return false;
  for (const [u, v] of [...mem]) {
    if (v.state === "signin" || v.state === "error") {
      mem.delete(u);
      emit(u);
      requestPreview(u);
    }
  }
  return true;
}

export function useArtifactPreview(url) {
  const subscribe = useCallback(
    (cb) => {
      if (!url) return () => {};
      if (!listeners.has(url)) listeners.set(url, new Set());
      listeners.get(url).add(cb);
      return () => listeners.get(url)?.delete(cb);
    },
    [url],
  );
  const get = useCallback(() => (url ? mem.get(url) ?? IDLE : UNAVAILABLE), [url]);
  const snap = useSyncExternalStore(subscribe, get, get);
  useEffect(() => {
    if (url) requestPreview(url);
  }, [url]);
  return snap;
}
