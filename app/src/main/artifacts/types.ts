import type { WebContentsView } from "electron";

export type ViewState = "idle" | "loading" | "ready" | "signin" | "error";
export interface ArtifactRef { slug: string; loginId: string | null; url: string; version?: string; title?: string }
export interface Rect { x: number; y: number; width: number; height: number }

export type TabPlace = { kind: "tab"; tabKey: string; rect: Rect; visible: boolean };
// A peek remembers the tab it took the view from, and hands it back on unpeek.
export type PeekPlace = { kind: "peek"; rect: Rect; from: TabPlace | null };
export type Placement = { kind: "none" } | PeekPlace | TabPlace;

// One pooled artifact view (ArtifactViewHost).
export interface Entry {
  slug: string;
  ref: ArtifactRef;
  partition: string;
  view: WebContentsView;
  state: ViewState;
  error?: string;
  placement: Placement;
  lastUsed: number;
  disposed: boolean;
  shown: boolean;
  radius: number;
  throttled: boolean;
  // Bumps per load; a timer or capture from an older load sees it moved on.
  seq: number;
  loadedVersion?: string;
  // The load whose document reached dom-ready.
  domSeq: number;
  // Bumps per committed document; the peek's inserted CSS lives in one document.
  doc: number;
  zoomKey: string | null;
  zoomPending: boolean;
  // This load's still isn't taken yet — the view keeps painting until it is (syncThrottle).
  capturing: boolean;
  recapture: boolean;
  stillDue: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
}

export function newEntry(ref: ArtifactRef, partition: string, view: WebContentsView): Entry {
  return {
    slug: ref.slug, ref, partition, view,
    state: "idle", placement: { kind: "none" }, lastUsed: Date.now(),
    disposed: false, shown: false, radius: 0, throttled: false,
    seq: 0, domSeq: -1, doc: 0, zoomKey: null, zoomPending: false,
    capturing: false, recapture: false, stillDue: false,
    timers: new Set(),
  };
}

// A timer that dies with its view.
export function later(e: Entry, ms: number, fn: () => void): void {
  const t = setTimeout(() => {
    e.timers.delete(t);
    if (!e.disposed) fn();
  }, ms);
  e.timers.add(t);
}
