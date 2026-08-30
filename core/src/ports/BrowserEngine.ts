// BrowserEngine port — the daemon's window onto ONE out-of-process browser.
// Pure types (core never imports Node); the CDP adapter in infra/src/browser
// satisfies this, manager/services/BrowserService drives it. Tab ids here are
// Eos-minted (contracts/src/browser.ts BrowserTab.tabId); the CDP targetId
// never crosses this boundary.

import type { BrowserDevice, BrowserElement } from "../../../contracts/src/browser.ts";

export interface BrowserEngineTabInfo {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  // Live audio state: audible comes from the injected audio guard; muted is the
  // user-level mute (browser_mute). The embedded lane reads these natively.
  audible: boolean;
  muted: boolean;
  // Small cached data URI (engine-resolved, size-capped) or null while
  // unresolved / non-http pages.
  faviconDataUri: string | null;
}

export type BrowserNavigateAction = "url" | "back" | "forward" | "reload";
export type BrowserActVerb = "click" | "hover" | "focus" | "check" | "uncheck";
export type BrowserScrollDirection = "up" | "down" | "top" | "bottom";
export type BrowserGetWhat = "text" | "url" | "title" | "value";

export interface BrowserSnapshotOptions {
  interactiveOnly: boolean;
  selector?: string;
  depth?: number;
}
export interface BrowserSnapshotResult {
  url: string;
  snapshot: string;
}

// A `@eN` ref that the per-tab ref map no longer knows — minted by an earlier
// snapshot and invalidated (navigation clears the map), or never minted. The
// route layer maps this to a 409 telling the caller to re-snapshot: a
// silently-wrong action on a recycled node is the worst failure this
// subsystem can have.
export class StaleRefError extends Error {}

export interface BrowserEngine {
  launch(): Promise<void>;
  isRunning(): boolean;
  // The Chrome binary this engine would/did launch, or null when none exists.
  binaryPath(): string | null;
  openTab(url: string): Promise<string>;
  closeTab(tabId: string): Promise<void>;
  listTabs(): Promise<BrowserEngineTabInfo[]>;
  // The tab an omitted tabId resolves to — the page the human sees (embedded
  // lane: the shown WebContentsView; headless fallback: the foreground target),
  // never "the first tab". null when nothing qualifies or the engine is down.
  activeTabId(): string | null;
  navigate(tabId: string, action: BrowserNavigateAction, url?: string): Promise<void>;

  // ---- agent surface (refs are per-tab, cleared on navigation) ------------
  snapshot(tabId: string, opts: BrowserSnapshotOptions): Promise<BrowserSnapshotResult>;
  find(tabId: string, query: string): Promise<BrowserElement[]>;
  act(tabId: string, ref: string, verb: BrowserActVerb): Promise<void>;
  typeText(tabId: string, ref: string, text: string, submit: boolean): Promise<void>;
  press(tabId: string, key: string): Promise<void>;
  scroll(tabId: string, direction: BrowserScrollDirection, ref?: string): Promise<void>;
  get(tabId: string, what: BrowserGetWhat, ref?: string): Promise<string>;
  // JPEG bytes, never PNG (png hangs on live pages).
  capture(tabId: string, fullPage: boolean): Promise<Uint8Array>;
  setDevice(tabId: string, device: BrowserDevice): Promise<void>;
  elementAt(tabId: string, x: number, y: number): Promise<BrowserElement>;
  // Cheap wait probes (the service owns the polling loop).
  textPresent(tabId: string, text: string): Promise<boolean>;
  refVisible(tabId: string, ref: string): Promise<boolean>;

  // User-level mute (the browser_mute tool). Unmuting restores the page's own
  // state — never volume-zeroing.
  setMuted(tabId: string, muted: boolean): Promise<void>;

  // Fires (possibly rapidly — callers debounce) whenever anything listTabs
  // reports may have changed without a service-initiated call: page/SPA
  // navigation, title change, load start/stop, favicon resolved, audible edge.
  onTabsChanged(cb: () => void): void;
  onExit(cb: (info: { code: number | null }) => void): void;
  dispose(): void;
}
