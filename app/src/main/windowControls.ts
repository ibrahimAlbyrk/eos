import { BrowserWindow, ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";

// The app's own minimize / maximize / close (ui WindowControls), for a shell that
// gives its windows no system controls. Each acts on the window that asked.
export function registerWindowControls(): void {
  const target = (e: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null => BrowserWindow.fromWebContents(e.sender);
  ipcMain.on("eosWindow:minimize", (e) => target(e)?.minimize());
  ipcMain.on("eosWindow:toggleMaximize", (e) => {
    const win = target(e);
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize();
  });
  ipcMain.on("eosWindow:close", (e) => target(e)?.close());
  ipcMain.handle("eosWindow:isMaximized", (e) => target(e)?.isMaximized() ?? false);
}

// Tells a window's page when it's maximized or restored, so the middle control
// shows the right glyph.
export function reportMaximized(win: BrowserWindow): void {
  const send = (): void => {
    if (!win.isDestroyed()) win.webContents.send("eosWindow:maximized", win.isMaximized());
  };
  win.on("maximize", send);
  win.on("unmaximize", send);
}
