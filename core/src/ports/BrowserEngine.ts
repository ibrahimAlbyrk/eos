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
  // Live audio state: audible comes from the injected audio guard; muted is
  // the user-level mute (the system-level "silenced while unviewed" flag is
  // engine-internal and never reported).
  audible: boolean;
  muted: boolean;
  // Small cached data URI (engine-resolved, size-capped) or null while
  // unresolved / non-http pages.
  faviconDataUri: string | null;
}

// One JPEG screencast frame. width/height are the encoded bitmap's pixel size
// (device px after the screencast maxWidth cap). The viewport's CSS size — what
// the client needs to translate canvas coords back to page coords — travels
// separately via viewport().
export interface BrowserFrame {
  tabId: string;
  data: Uint8Array;
  width: number;
  height: number;
}

// The panel's live display size — the daemon streams the RESPONSIVE tab 1:1
// with this (native device px, no up/downscale blur) and applies it as the
// emulated viewport so the frame aspect matches the panel (no letterbox).
// Mobile/Tablet ignore it and keep their fixed device profiles. dpr is the UI's
// devicePixelRatio, used as the CDP deviceScaleFactor.
export interface DisplaySize {
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

// Human input event shapes (plan §3.4), forwarded to CDP Input.dispatch*.
// windowsVirtualKeyCode is an addition over §3.4: CDP needs it for non-text
// keys (Enter/Tab/arrows) to reach many pages' key handlers.
export interface BrowserMouseInput {
  kind: "mouse";
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  x: number;
  y: number;
  button?: "left" | "right" | "middle" | "none";
  buttons?: number;
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}
export interface BrowserKeyInput {
  kind: "key";
  type: "keyDown" | "keyUp" | "rawKeyDown" | "char";
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
  windowsVirtualKeyCode?: number;
}
export interface BrowserInsertInput {
  kind: "insert";
  text: string;
}
export type BrowserInputEvent = BrowserMouseInput | BrowserKeyInput | BrowserInsertInput;

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
  // The foreground tab — the one the panel is viewing. A background target
  // emits zero screencast frames, so subscribe/bringToFront tracks it; an
  // omitted tabId resolves HERE, never to "the first tab", so an agent's "this
  // page" is the page the human sees. null when no real tab is foreground (only
  // the invisible keep-alive target, or the engine is down).
  activeTabId(): string | null;
  navigate(tabId: string, action: BrowserNavigateAction, url?: string): Promise<void>;
  startScreencast(tabId: string, display: DisplaySize, onFrame: (frame: BrowserFrame) => void): Promise<void>;
  stopScreencast(tabId: string): Promise<void>;
  // Re-apply the display size to an already-streaming tab: RESPONSIVE re-emulates
  // the viewport and restarts the screencast at the new native size; Mobile/Tablet
  // ignore it (fixed profiles). No-op when the tab has no live screencast, so a
  // panel resize never disturbs the subscriber refcount (no audio-silence blip).
  setDisplaySize(tabId: string, display: DisplaySize): Promise<void>;
  dispatchInput(tabId: string, event: BrowserInputEvent): Promise<void>;
  // CSS px; per-tab once device emulation applies, engine default without a tab.
  viewport(tabId?: string): { width: number; height: number };

  // ---- agent surface (refs are per-tab, cleared on navigation) ------------
  snapshot(tabId: string, opts: BrowserSnapshotOptions): Promise<BrowserSnapshotResult>;
  find(tabId: string, query: string): Promise<BrowserElement[]>;
  act(tabId: string, ref: string, verb: BrowserActVerb): Promise<void>;
  typeText(tabId: string, ref: string, text: string, submit: boolean): Promise<void>;
  press(tabId: string, key: string): Promise<void>;
  scroll(tabId: string, direction: BrowserScrollDirection, ref?: string): Promise<void>;
  get(tabId: string, what: BrowserGetWhat, ref?: string): Promise<string>;
  // JPEG bytes, never PNG (png hangs on live pages and stalls the screencast).
  capture(tabId: string, fullPage: boolean): Promise<Uint8Array>;
  setDevice(tabId: string, device: BrowserDevice): Promise<void>;
  elementAt(tabId: string, x: number, y: number): Promise<BrowserElement>;
  // Cheap wait probes (the service owns the polling loop).
  textPresent(tabId: string, text: string): Promise<boolean>;
  refVisible(tabId: string, ref: string): Promise<boolean>;

  // ---- audio --------------------------------------------------------------
  // User-level mute (the /mute route) vs system-level silence (no viewer on
  // the tab). Effective mute = either; unmuting restores the page's own state
  // — never volume-zeroing.
  setMuted(tabId: string, muted: boolean): Promise<void>;
  setSilenced(tabId: string, silenced: boolean): Promise<void>;

  // Fires (possibly rapidly — callers debounce) whenever anything listTabs
  // reports may have changed without a service-initiated call: page/SPA
  // navigation, title change, load start/stop, favicon resolved, audible edge.
  onTabsChanged(cb: () => void): void;
  onExit(cb: (info: { code: number | null }) => void): void;
  dispose(): void;
}
