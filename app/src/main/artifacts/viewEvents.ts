import { shell } from "electron";
import { setZoom } from "./placement";
import { later, type Entry, type ViewState } from "./types";
import { isLoginUrl, isViewerUrl, isWeb } from "./viewerUrls";

const READY_DELAY_MS = 600;

export interface ViewHooks {
  setState(e: Entry, state: ViewState, error?: string): void;
  sendOverlay(e: Entry): void;
}

// A view's page lifecycle → its state, and the navigation lockdown.
export function wireView(e: Entry, hooks: ViewHooks): void {
  const wc = e.view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (e.shown && isWeb(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Only the claude.ai artifact viewer stays in the view; a link the user
  // follows elsewhere opens in the system browser.
  wc.on("will-navigate", (ev) => {
    if (!ev.isMainFrame || isViewerUrl(ev.url)) return;
    ev.preventDefault();
    if (isLoginUrl(ev.url)) hooks.setState(e, "signin");
    else if (e.shown && isWeb(ev.url)) void shell.openExternal(ev.url);
  });
  wc.on("will-redirect", (ev) => {
    if (!ev.isMainFrame || isViewerUrl(ev.url)) return;
    ev.preventDefault();
    if (isLoginUrl(ev.url)) hooks.setState(e, "signin");
    else hooks.setState(e, "error", "claude.ai sent this artifact somewhere else");
  });
  // claude.ai routes client-side too, which no will-navigate announces.
  wc.on("did-navigate-in-page", (_ev, url, isMainFrame) => {
    if (!isMainFrame) return;
    if (isLoginUrl(url)) {
      hooks.setState(e, "signin");
    } else if (!isViewerUrl(url)) {
      if (e.shown && isWeb(url)) void shell.openExternal(url);
      if (e.shown && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else hooks.setState(e, "error", "The artifact page moved away");
    } else {
      hooks.sendOverlay(e);
    }
  });
  wc.on("did-navigate", (_ev, url) => {
    e.doc++;
    e.zoomKey = null;
    if (isLoginUrl(url)) hooks.setState(e, "signin");
  });
  wc.on("dom-ready", () => {
    e.domSeq = e.seq;
    if (e.placement.kind === "peek") void setZoom(e, true);
    hooks.sendOverlay(e);
  });
  wc.on("did-finish-load", () => {
    if (e.state !== "loading") return;
    const seq = e.seq;
    later(e, READY_DELAY_MS, () => {
      if (e.seq === seq && e.state === "loading") hooks.setState(e, "ready");
    });
  });
  wc.on("did-fail-load", (_ev, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted (a guard above, or a newer load)
    hooks.setState(e, "error", description || `Load failed (${code})`);
  });
  wc.on("render-process-gone", (_ev, details) => {
    hooks.setState(e, "error", `The page stopped (${details.reason})`);
  });
}
