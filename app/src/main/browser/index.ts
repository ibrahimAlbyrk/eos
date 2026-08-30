import { ipcMain, type BaseWindow } from "electron";
import { ViewManager } from "./views";
import { MainWebContentsDriver } from "./driver";
import { HostChannel } from "./channel";

// initBrowserHost — wire the embedded-browser lane in the Electron main process:
// the ViewManager (native views), the MainWebContentsDriver (CDP automation),
// and the HostChannel (control channel to the daemon). Plus the renderer's
// geometry/visibility IPC (eosBrowserView in the preload). Called once, after the
// main window exists.

let started = false;

export function initBrowserHost(deps: { win: BaseWindow; daemonUrl: string; uiToken: string }): void {
  if (started) return; // idempotent — the IPC + host live for the app's lifetime
  started = true;

  const channel = new HostChannel({ daemonUrl: deps.daemonUrl, uiToken: deps.uiToken });
  const views = new ViewManager({
    win: deps.win,
    notify: (sessionKey, event, payload) => channel.emitEvent(sessionKey, event, payload),
  });
  const driver = new MainWebContentsDriver(views);
  // A popup becomes a tab: open it via the driver (which mints the tabId the
  // daemon will also see) then nudge the daemon to re-read the tab list.
  views.setOpenTab((sessionKey, url) => {
    void driver
      .handle("openTab", sessionKey, [url])
      .then(() => channel.emitEvent(sessionKey, "tabsChanged"))
      .catch((e) => console.error("[eos-browser] popup→tab failed:", e instanceof Error ? e.message : String(e)));
  });
  channel.setDriver(driver);

  // Renderer → main geometry/visibility only (plan §C: no webContents, no verbs
  // over this channel; state-changing verbs flow through the daemon REST path).
  ipcMain.on("browserView:setActiveView", (_e, arg: { sessionKey?: unknown; tabId?: unknown }) => {
    if (arg && typeof arg.sessionKey === "string" && typeof arg.tabId === "string") {
      views.setActiveView(arg.sessionKey, arg.tabId);
    }
  });
  ipcMain.on("browserView:setBounds", (_e, rect: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }) => {
    if (rect && [rect.x, rect.y, rect.width, rect.height].every((n) => typeof n === "number")) {
      views.setBounds(rect as { x: number; y: number; width: number; height: number });
    }
  });
  ipcMain.on("browserView:setVisible", (_e, visible: unknown) => views.setVisible(Boolean(visible)));
  ipcMain.on("browserView:overlay", (_e, open: unknown) => views.setOverlay(Boolean(open)));

  // Native element picker (human): drive Chromium's inspect overlay on the live
  // view and return the picked element to the renderer. Cancel abandons an
  // in-flight pick (the human left pick mode).
  ipcMain.handle("browserView:pick", async (_e, tabId: unknown) => {
    if (typeof tabId !== "string") return null;
    try {
      return await driver.pickElement(tabId);
    } catch (e) {
      console.error("[eos-browser] pick failed:", e instanceof Error ? e.message : String(e));
      return null;
    }
  });
  ipcMain.on("browserView:pickCancel", () => driver.cancelPick());

  channel.start();
}
