// The dashboard's side of window.eosArtifacts — the Electron bridge that hosts
// live claude.ai artifact views (one per artifact; warm off-screen, a peek
// miniature or a side-panel tab). Absent in a plain browser and in views of
// another computer: then there is no peek and no tab, and a click opens
// claude.ai in the system browser. Here: view states, stills, the one peek, and
// which tab last took each artifact's view.

import { useCallback, useEffect, useSyncExternalStore } from "react";

export const artifactBridge = () => (typeof window !== "undefined" ? window.eosArtifacts ?? null : null);

// ⌥-click, and every click without the bridge. The shell sends a window.open of
// an http(s) URL to the system browser.
export function openArtifactExternally(url) {
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}

// ── keyed listeners ──────────────────────────────────────────────────────────

function keyedBus() {
  const subs = new Map(); // key -> Set<fn>
  return {
    subscribe(key, fn) {
      if (!subs.has(key)) subs.set(key, new Set());
      subs.get(key).add(fn);
      return () => subs.get(key)?.delete(fn);
    },
    emit(key) {
      for (const fn of subs.get(key) ?? []) fn();
    },
  };
}

// ── view states ──────────────────────────────────────────────────────────────

const IDLE = Object.freeze({ state: "idle", error: null });
const states = new Map(); // slug -> { state, error }
const stateBus = keyedBus();
const actionSubs = new Set();
let wired = false;

function setState(slug, state, error = null) {
  const prev = states.get(slug);
  if (prev?.state === state && prev?.error === error) return;
  states.set(slug, Object.freeze({ state, error }));
  stateBus.emit(slug);
}

// One bridge subscription each for states and toolbar actions, fanned out here.
function wire() {
  const bridge = artifactBridge();
  if (wired || !bridge) return;
  wired = true;
  bridge.onState?.(({ slug, state, error }) => {
    if (!slug) return;
    setState(slug, state, error ?? null);
    // A view that just loaded may have left a fresh still behind.
    if (state === "ready") dropMissingStills(slug);
  });
  bridge.onAction?.((a) => {
    for (const fn of actionSubs) fn(a);
  });
}

export function useArtifactViewState(slug) {
  const subscribe = useCallback((fn) => (slug ? stateBus.subscribe(slug, fn) : () => {}), [slug]);
  const get = useCallback(() => (slug ? states.get(slug) ?? IDLE : IDLE), [slug]);
  useEffect(() => {
    const bridge = artifactBridge();
    if (!slug || !bridge) return;
    wire();
    if (states.has(slug)) return;
    let live = true;
    Promise.resolve(bridge.state?.(slug)).then((s) => {
      if (live && s && !states.has(slug)) setState(slug, s);
    }, () => {});
    return () => { live = false; };
  }, [slug]);
  return useSyncExternalStore(subscribe, get, get);
}

// ({ slug, action }) from a tab's floating toolbar.
export function onArtifactAction(fn) {
  wire();
  actionSubs.add(fn);
  return () => actionSubs.delete(fn);
}

// ── stills (slug@version → JPEG data URL, kept by main) ─────────────────────

const stills = new Map(); // key -> dataUrl | null (none yet)
const pending = new Set();
const stillBus = keyedBus();
const stillKey = (ref) => (ref?.slug ? `${ref.slug}@${ref.version ?? ""}` : null);

function requestStill(ref) {
  const key = stillKey(ref);
  const bridge = artifactBridge();
  if (!key || !bridge?.still || stills.has(key) || pending.has(key)) return;
  pending.add(key);
  Promise.resolve(bridge.still(ref))
    .then((url) => stills.set(key, typeof url === "string" && url ? url : null), () => stills.set(key, null))
    .finally(() => { pending.delete(key); stillBus.emit(key); });
}

function dropMissingStills(slug) {
  for (const [key, url] of stills) {
    if (url === null && key.startsWith(`${slug}@`)) {
      stills.delete(key);
      stillBus.emit(key);
    }
  }
}

// The still for this version, or null while there is none.
export function useArtifactStill(ref) {
  const key = stillKey(ref);
  const subscribe = useCallback((fn) => (key ? stillBus.subscribe(key, fn) : () => {}), [key]);
  const get = useCallback(() => (key ? stills.get(key) ?? null : null), [key]);
  const url = useSyncExternalStore(subscribe, get, get);
  const missing = Boolean(key) && !stills.has(key);
  useEffect(() => {
    if (missing) requestStill(ref);
    // the key names the version; the rest of ref doesn't change which still it is
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, missing]);
  return url;
}

// ── warm-up, peek, tabs ──────────────────────────────────────────────────────

const warmed = new Set();

// Once per version per session: main keeps a warm view in its pool.
export function warmArtifact(ref) {
  const key = stillKey(ref);
  const bridge = artifactBridge();
  if (!key || !bridge || warmed.has(key)) return;
  warmed.add(key);
  bridge.warm(ref);
}

let peeked = null; // slug in the peek
const peekEnds = new Set();

export function peekArtifact(ref, rect) {
  const bridge = artifactBridge();
  if (!bridge) return;
  wire();
  const prev = peeked;
  peeked = ref.slug;
  bridge.peek(ref, rect);
  if (prev && prev !== ref.slug) for (const fn of peekEnds) fn(prev);
}

// A tab showing the same artifact takes its view back (onPeekEnd).
export function unpeekArtifact() {
  const bridge = artifactBridge();
  if (!bridge || peeked === null) return;
  const slug = peeked;
  peeked = null;
  bridge.unpeek();
  for (const fn of peekEnds) fn(slug);
}

export function onPeekEnd(fn) {
  peekEnds.add(fn);
  return () => peekEnds.delete(fn);
}

const holders = new Map(); // slug -> tabKey of the newest attach

export function attachArtifact(tabKey, ref, rect) {
  const bridge = artifactBridge();
  if (!bridge) return;
  wire();
  holders.set(ref.slug, tabKey);
  bridge.attach(tabKey, ref, rect);
}

export function detachArtifact(tabKey, slug) {
  const bridge = artifactBridge();
  if (!bridge) return;
  if (holders.get(slug) === tabKey) holders.delete(slug);
  bridge.detach(tabKey);
}

// The tab that holds an artifact's view — the one its toolbar's actions are for.
export function artifactHolder(slug) {
  return holders.get(slug) ?? null;
}
