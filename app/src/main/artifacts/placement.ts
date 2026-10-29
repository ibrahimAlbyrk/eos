import type { Entry, Rect } from "./types";

// A hidden view keeps a real size, so its page has a layout viewport to load and be captured at.
const HIDDEN_SIZE = { width: 1280, height: 800 };
const PEEK_CSS = "html{zoom:.5 !important}";
const PEEK_RADIUS = 10;
const TAB_RADIUS = 12;

export const hiddenRect = (): Rect => ({ x: 0, y: 0, ...HIDDEN_SIZE });

// Bounds, visibility, corner radius and mute from the placement and state. A
// placed view shows only once ready (the renderer paints the still till then)
// and keeps the place's size while it waits, so it appears laid out.
export function applyPlacement(e: Entry, ctx: { covered: () => boolean; onScreen: () => boolean }): void {
  if (e.disposed) return;
  const p = e.placement;
  const rect = p.kind === "none" ? null : p.rect;
  const sized = !!rect && rect.width > 0 && rect.height > 0;
  const wanted = p.kind === "peek" || (p.kind === "tab" && p.visible);
  const show = wanted && sized && e.state === "ready" && !ctx.covered();
  const bounds = sized && rect ? rect : hiddenRect();
  const radius = p.kind === "peek" ? PEEK_RADIUS : p.kind === "tab" ? TAB_RADIUS : 0;
  try {
    if (radius !== e.radius) {
      e.view.setBorderRadius(radius);
      e.radius = radius;
    }
    if (show) {
      e.view.setBounds(bounds);
      e.view.setVisible(true);
    } else {
      e.view.setVisible(false);
      e.view.setBounds(bounds);
    }
    e.shown = show;
    // Sound only from a tab the user is looking at; the peek stays silent.
    e.view.webContents.setAudioMuted(!(show && ctx.onScreen() && p.kind === "tab"));
  } catch {
    // the view is closing
  }
  syncThrottle(e);
}

// The peek's half-zoom miniature, as CSS inserted into the current document.
export async function setZoom(e: Entry, on: boolean): Promise<void> {
  const wc = e.view.webContents;
  if (!on) {
    const key = e.zoomKey;
    e.zoomKey = null;
    if (key) await wc.removeInsertedCSS(key).catch(() => {});
    return;
  }
  if (e.zoomKey || e.zoomPending) return;
  e.zoomPending = true;
  const doc = e.doc;
  try {
    const key = await wc.insertCSS(PEEK_CSS);
    if (e.disposed) return;
    if (e.doc !== doc) return; // landed in a document that's gone; dom-ready inserts it again
    if (e.placement.kind === "peek") e.zoomKey = key;
    else await wc.removeInsertedCSS(key).catch(() => {});
  } catch {
    // no document yet — dom-ready inserts it
  } finally {
    e.zoomPending = false;
  }
}

// Chromium may throttle a view nobody sees once its still is taken; until
// then a hidden page has to keep painting.
export function syncThrottle(e: Entry): void {
  const throttle = !e.shown && !e.capturing;
  if (e.disposed || throttle === e.throttled) return;
  try {
    e.view.webContents.setBackgroundThrottling(throttle);
    e.throttled = throttle;
  } catch {
    // closing
  }
}
