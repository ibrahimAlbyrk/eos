import { Menu, clipboard } from "electron";
import type { WebContents, MenuItemConstructorOptions } from "electron";

// The app menu is load-bearing: on macOS the menu accelerators consume
// ⌘Z/⌘C/⌘X/⌘V/⌘A before the renderer sees them, so — exactly like the Swift
// shell (doc 10 §e, main.swift:998-1041) — Undo/Redo route to the composer's own
// stack via __eosUndo/__eosRedo, and clipboard ops route through the terminal
// bridge (__eosTerm.*) when a terminal is focused, else fall back to the
// WebContents editing commands. NOT the default roles, which would fire
// Chromium's contentEditable undo and bypass the composer stack.
export function buildAppMenu(getWC: () => WebContents | null): void {
  const run = (js: string): Promise<unknown> =>
    getWC()?.executeJavaScript(js, true).catch(() => null) ?? Promise.resolve(null);

  async function copy(): Promise<void> {
    const wc = getWC();
    if (!wc) return;
    const sel = await run("window.__eosTerm?.getSelectionIfFocused() ?? null");
    if (typeof sel === "string") clipboard.writeText(sel);
    else wc.copy();
  }
  async function cut(): Promise<void> {
    const wc = getWC();
    if (!wc) return;
    // Terminal is read-only ⇒ cut behaves as copy (doc 10 §d, main.swift:1011).
    const sel = await run("window.__eosTerm?.getSelectionIfFocused() ?? null");
    if (typeof sel === "string") clipboard.writeText(sel);
    else wc.cut();
  }
  async function paste(): Promise<void> {
    const wc = getWC();
    if (!wc) return;
    const focused = await run("window.__eosTerm?.isFocused() === true");
    if (focused === true) {
      const b64 = Buffer.from(clipboard.readText(), "utf8").toString("base64");
      void run(`window.__eosTerm.pasteBase64(${JSON.stringify(b64)})`);
    } else {
      wc.paste();
    }
  }
  async function selectAll(): Promise<void> {
    const wc = getWC();
    if (!wc) return;
    const focused = await run("window.__eosTerm?.isFocused() === true");
    if (focused === true) void run("window.__eosTerm.selectAll()");
    else wc.selectAll();
  }

  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    {
      label: "Edit",
      submenu: [
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => void run("window.__eosUndo && window.__eosUndo()") },
        { label: "Redo", accelerator: "Shift+CmdOrCtrl+Z", click: () => void run("window.__eosRedo && window.__eosRedo()") },
        { type: "separator" },
        { label: "Cut", accelerator: "CmdOrCtrl+X", click: cut },
        { label: "Copy", accelerator: "CmdOrCtrl+C", click: copy },
        { label: "Paste", accelerator: "CmdOrCtrl+V", click: paste },
        { label: "Select All", accelerator: "CmdOrCtrl+A", click: selectAll },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Reload",
          accelerator: "CmdOrCtrl+R",
          click: async () => {
            const wc = getWC();
            if (!wc) return;
            await wc.session.clearCache(); // HTTP cache only — preserves localStorage (doc 10 §a)
            wc.reload();
          },
        },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
