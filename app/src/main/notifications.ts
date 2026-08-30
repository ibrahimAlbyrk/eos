import { app, Notification, BrowserWindow } from "electron";
import { navigateToWorker } from "./bridge";

// Fires a native notification from an SSE `notification:fire` payload, but ONLY
// when the app is not active/frontmost (mirrors doc 10 :864-867). Click →
// activate + show + __nativeNavigate to the worker. Returns the outcome so the
// focus gate is testable. `getWindow`/`showWindow` are supplied by index.ts.
export function makeNotifier(
  getWindow: () => BrowserWindow | null,
  showWindow: () => void,
): (payload: unknown) => "fired" | "suppressed" | "unsupported" | "invalid" {
  return (payload) => {
    if (!Notification.isSupported()) return "unsupported";
    const p = payload as { title?: unknown; body?: unknown; workerId?: unknown };
    if (typeof p?.title !== "string" || typeof p?.body !== "string") return "invalid";
    const win = getWindow();
    if (win && win.isFocused()) return "suppressed"; // app active — no banner
    const workerId = typeof p.workerId === "string" ? p.workerId : "";
    const n = new Notification({ title: p.title, body: p.body });
    n.on("click", () => {
      app.focus({ steal: true });
      showWindow();
      const wc = getWindow()?.webContents;
      if (wc && workerId) navigateToWorker(wc, workerId);
    });
    n.show();
    return "fired";
  };
}
