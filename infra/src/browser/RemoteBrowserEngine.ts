// RemoteBrowserEngine — the BrowserEngine port implemented as a thin RPC proxy
// over a control channel to an app-hosted WebContentsView driver (the embedded
// lane). Each port method becomes ONE round trip (proxying at the port, not at
// raw CDP: a single act is ~5 CDP calls but one port hop). The automation
// semantics — a11y snapshots, @eN refs, StaleRefError — live in the app driver;
// this side only serializes calls and rehydrates typed errors so the route's
// 409/StaleRefError mapping still fires across the process boundary.
//
// Sync port methods (isRunning/binaryPath/activeTabId/viewport) cannot RPC, so
// they read cached state kept live by the channel's unsolicited events.
// Presentation methods (startScreencast/dispatchInput/…) are no-ops here: the
// human drives the native view directly, never a screencast.

import type {
  BrowserActVerb,
  BrowserEngine,
  BrowserEngineTabInfo,
  BrowserGetWhat,
  BrowserNavigateAction,
  BrowserScrollDirection,
  BrowserSnapshotOptions,
  BrowserSnapshotResult,
} from "../../../core/src/ports/BrowserEngine.ts";
import { StaleRefError } from "../../../core/src/ports/BrowserEngine.ts";
import type { BrowserDevice, BrowserElement } from "../../../contracts/src/browser.ts";

// The daemon↔app control channel, one per session. Implemented in the manager
// (AppBrowserHost) — declared HERE so infra gains no manager dependency; the
// channel injects this channel's sessionKey into every frame.
export interface RemoteBrowserChannel {
  // Invoke a port method on the app host. Rejects with an Error whose `.name` is
  // the remote error's class name (so StaleRefError survives the hop).
  call(method: string, args: unknown[]): Promise<unknown>;
  // Unsolicited app→daemon notifications: "tabsChanged" | "activeTabChanged" | "exit".
  onEvent(cb: (event: string, payload: unknown) => void): void;
  // The host connection dropped (app quit / deregistered) — the engine is gone.
  onClose(cb: () => void): void;
  isOpen(): boolean;
}

// The embedded lane always has a real browser when a host is registered; status
// only reads this to decide "absent" vs available, so any non-null sentinel works.
const EMBEDDED_BINARY = "WebContentsView (embedded)";

export class RemoteBrowserEngine implements BrowserEngine {
  private channel: RemoteBrowserChannel;
  private exitCbs: Array<(info: { code: number | null }) => void> = [];
  private tabsChangedCbs: Array<() => void> = [];
  private cachedActiveTabId: string | null = null;
  private exited = false;

  constructor(channel: RemoteBrowserChannel) {
    this.channel = channel;
    channel.onEvent((event, payload) => {
      if (event === "tabsChanged") {
        for (const cb of this.tabsChangedCbs) cb();
      } else if (event === "activeTabChanged") {
        this.cachedActiveTabId = (payload as { tabId?: string | null } | null)?.tabId ?? null;
      } else if (event === "exit") {
        this.fireExit((payload as { code?: number | null } | null)?.code ?? null);
      }
    });
    channel.onClose(() => this.fireExit(null));
  }

  // One place maps a remote typed error back to its class — the route layer
  // branches on `instanceof StaleRefError`, so it must survive serialization.
  private async invoke(method: string, args: unknown[]): Promise<unknown> {
    try {
      return await this.channel.call(method, args);
    } catch (e) {
      const name = (e as { name?: string } | null)?.name;
      const message = e instanceof Error ? e.message : String(e);
      if (name === "StaleRefError") throw new StaleRefError(message);
      throw e instanceof Error ? e : new Error(message);
    }
  }

  private fireExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const cb of this.exitCbs) cb({ code });
  }

  async launch(): Promise<void> {
    await this.invoke("launch", []);
  }

  isRunning(): boolean {
    return !this.exited && this.channel.isOpen();
  }

  binaryPath(): string | null {
    return EMBEDDED_BINARY;
  }

  async openTab(url: string): Promise<string> {
    return (await this.invoke("openTab", [url])) as string;
  }

  async closeTab(tabId: string): Promise<void> {
    await this.invoke("closeTab", [tabId]);
  }

  async listTabs(): Promise<BrowserEngineTabInfo[]> {
    return (await this.invoke("listTabs", [])) as BrowserEngineTabInfo[];
  }

  activeTabId(): string | null {
    return this.cachedActiveTabId;
  }

  async navigate(tabId: string, action: BrowserNavigateAction, url?: string): Promise<void> {
    await this.invoke("navigate", [tabId, action, url ?? null]);
  }

  // ---- agent surface --------------------------------------------------------
  async snapshot(tabId: string, opts: BrowserSnapshotOptions): Promise<BrowserSnapshotResult> {
    return (await this.invoke("snapshot", [tabId, opts])) as BrowserSnapshotResult;
  }

  async find(tabId: string, query: string): Promise<BrowserElement[]> {
    return (await this.invoke("find", [tabId, query])) as BrowserElement[];
  }

  async act(tabId: string, ref: string, verb: BrowserActVerb): Promise<void> {
    await this.invoke("act", [tabId, ref, verb]);
  }

  async typeText(tabId: string, ref: string, text: string, submit: boolean): Promise<void> {
    await this.invoke("typeText", [tabId, ref, text, submit]);
  }

  async press(tabId: string, key: string): Promise<void> {
    await this.invoke("press", [tabId, key]);
  }

  async scroll(tabId: string, direction: BrowserScrollDirection, ref?: string): Promise<void> {
    await this.invoke("scroll", [tabId, direction, ref ?? null]);
  }

  async get(tabId: string, what: BrowserGetWhat, ref?: string): Promise<string> {
    return (await this.invoke("get", [tabId, what, ref ?? null])) as string;
  }

  // The driver returns base64 JPEG over the text channel; rehydrate to bytes so
  // BrowserService writes the temp file exactly as it does for the headless lane.
  async capture(tabId: string, fullPage: boolean): Promise<Uint8Array> {
    const b64 = (await this.invoke("capture", [tabId, fullPage])) as string;
    return Buffer.from(b64, "base64");
  }

  async setDevice(tabId: string, device: BrowserDevice): Promise<void> {
    await this.invoke("setDevice", [tabId, device]);
  }

  async elementAt(tabId: string, x: number, y: number): Promise<BrowserElement> {
    return (await this.invoke("elementAt", [tabId, x, y])) as BrowserElement;
  }

  async textPresent(tabId: string, text: string): Promise<boolean> {
    return (await this.invoke("textPresent", [tabId, text])) as boolean;
  }

  async refVisible(tabId: string, ref: string): Promise<boolean> {
    return (await this.invoke("refVisible", [tabId, ref])) as boolean;
  }

  async setMuted(tabId: string, muted: boolean): Promise<void> {
    await this.invoke("setMuted", [tabId, muted]);
  }

  onTabsChanged(cb: () => void): void {
    this.tabsChangedCbs.push(cb);
  }

  onExit(cb: (info: { code: number | null }) => void): void {
    this.exitCbs.push(cb);
  }

  dispose(): void {
    // Best-effort: ask the app to tear down this session's views. The channel may
    // already be closed (host gone) — ignore the rejection.
    void this.channel.call("dispose", []).catch(() => {});
  }
}
