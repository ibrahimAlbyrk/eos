import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { WebContents } from "electron";

// The Transfer tab inside a view of another computer. That view's code can only
// reach that computer (its CSP pins it to the host's facade prefix), so it can't
// talk to this Mac's transfer engine — this bridge carries the few calls it needs.
//
// The rules, held here rather than trusted to the page:
//   * only views running this Mac's own dashboard get through (a host-served
//     bundle is that computer's code);
//   * the other side is always the host the asking view shows — never a value
//     the page sends;
//   * this Mac's paths come only from its own native pickers: the page names a
//     path on the host it shows, never one here.

interface Deps {
  daemonUrl: string;
  uiToken: string;
  hostFor: (wc: WebContents) => { id: string; trusted: boolean } | null;
  contentsFor: (hostId: string) => WebContents[];
  hostContents: () => WebContents[];
  fallbackWindow: () => BrowserWindow | null;
}

interface Transfer {
  id: string;
  from: string;
  to: string;
  placed: Array<{ name: string; path: string }>;
}

type Reply = { value?: unknown; error?: string; code?: string };

const ACTIONS = new Set(["pause", "resume", "cancel", "decide"]);

export class TransferBridge {
  private readonly deps: Deps;
  // The folder last picked natively for a view — what "save to the folder I chose" means.
  private readonly chosen = new Map<number, string>();

  constructor(deps: Deps) {
    this.deps = deps;
    const on = (channel: string, fn: (hostId: string, wc: WebContents, arg: Record<string, unknown>) => Promise<unknown>): void => {
      ipcMain.handle(channel, async (e, arg: unknown): Promise<Reply> => {
        const host = this.deps.hostFor(e.sender);
        if (!host) return { error: "not a view of another computer", code: "forbidden" };
        if (!host.trusted) return { error: "Transfers from this view need the same Eos version on both Macs.", code: "needs-update" };
        try {
          return { value: await fn(host.id, e.sender, arg && typeof arg === "object" ? (arg as Record<string, unknown>) : {}) };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code };
        }
      });
    };

    on("eosTransfer:list", async (hostId) => (await this.list()).filter((t) => involves(t, hostId)));

    on("eosTransfer:destination", (hostId, _wc, arg) =>
      this.call("POST", "/api/transfers/destination", { from: hostId, to: "local", paths: hostPaths(arg.paths) }));

    on("eosTransfer:chooseFolder", async (_hostId, wc) => {
      const r = await dialog.showOpenDialog(this.windowOf(wc), {
        title: "Save to", buttonLabel: "Choose", properties: ["openDirectory", "createDirectory"],
      });
      const dir = r.canceled ? null : r.filePaths[0] ?? null;
      if (!dir) return null;
      this.chosen.set(wc.id, dir);
      return { destDir: dir };
    });

    // That computer → this Mac: into the folder picked here, else the engine's choice.
    on("eosTransfer:pull", (hostId, wc, arg) => this.call("POST", "/api/transfers", {
      from: hostId, to: "local", paths: hostPaths(arg.paths),
      destDir: arg.chosen === true ? this.chosen.get(wc.id) ?? null : null,
    }));

    // This Mac → that computer: what's sent is what the user picks right now, here.
    on("eosTransfer:push", async (hostId, wc, arg) => {
      const destDir = typeof arg.destDir === "string" && arg.destDir.startsWith("/") ? arg.destDir : null;
      const r = await dialog.showOpenDialog(this.windowOf(wc), {
        title: "Send to the other Mac", buttonLabel: "Send", properties: ["openFile", "openDirectory", "multiSelections"],
      });
      if (r.canceled || !r.filePaths.length) return null;
      return this.call("POST", "/api/transfers", { from: "local", to: hostId, paths: r.filePaths, destDir });
    });

    on("eosTransfer:act", async (hostId, _wc, arg) => {
      const id = String(arg.id ?? "");
      const action = String(arg.action ?? "");
      if (!ACTIONS.has(action)) throw new Error("unknown action");
      await this.mine(hostId, id);
      return this.call("POST", `/api/transfers/${encodeURIComponent(id)}/${action}`, action === "decide" ? { decisions: arg.decisions ?? {} } : {});
    });

    on("eosTransfer:clear", () => this.call("DELETE", "/api/transfers"));

    on("eosTransfer:reveal", async (hostId, _wc, arg) => {
      const t = await this.mine(hostId, String(arg.id ?? ""));
      if (t.to === "local" && t.placed[0]) shell.showItemInFolder(t.placed[0].path);
      return null;
    });
  }

  // A transfer:change from this Mac's stream → the views of the host it involves.
  forward(payload: unknown): void {
    const p = payload as { transfer?: Transfer; removed?: unknown } | null;
    if (!p || typeof p !== "object") return;
    if (p.transfer) {
      const hostId = p.transfer.from === "local" ? p.transfer.to : p.transfer.from;
      this.send(this.deps.contentsFor(hostId), payload);
    } else if (Array.isArray(p.removed)) {
      // A cleared id means nothing to a view that never had it.
      this.send(this.deps.hostContents(), payload);
    }
  }

  private send(targets: WebContents[], payload: unknown): void {
    for (const wc of targets) {
      if (wc.isDestroyed() || !this.deps.hostFor(wc)?.trusted) continue;
      wc.send("eosTransfer:changed", payload);
    }
  }

  private windowOf(wc: WebContents): BrowserWindow {
    const win = BrowserWindow.fromWebContents(wc) ?? this.deps.fallbackWindow();
    if (!win) throw new Error("no window to show the picker in");
    return win;
  }

  private async list(): Promise<Transfer[]> {
    const body = (await this.call("GET", "/api/transfers")) as { transfers?: Transfer[] };
    return body.transfers ?? [];
  }

  // A transfer this view may act on: one between this Mac and the host it shows.
  private async mine(hostId: string, id: string): Promise<Transfer> {
    const t = (await this.list()).find((x) => x.id === id);
    if (!t || !involves(t, hostId)) throw new Error("not a transfer with this computer");
    return t;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.deps.daemonUrl}${path}`, {
      method,
      headers: { "x-eos-ui-token": this.deps.uiToken, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: unknown = null;
    try { parsed = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const b = parsed as { error?: string; code?: string } | null;
      throw Object.assign(new Error(b?.error ?? `transfer request failed (${res.status})`), { code: b?.code });
    }
    return parsed;
  }
}

function involves(t: Transfer, hostId: string): boolean {
  return t.from === hostId || t.to === hostId;
}

// Paths on the host the view shows — absolute strings, nothing else.
function hostPaths(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > 500) throw new Error("pick something to send");
  return v.map((p) => {
    if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) throw new Error("bad path");
    return p;
  });
}
