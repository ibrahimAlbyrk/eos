import { app, ipcMain } from "electron";
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { rm } from "node:fs/promises";
import path from "node:path";
import { artifactSlugFromUrl, artifactViewerUrl, shortIdOf } from "../../../../contracts/src/artifact-ids";
import { ArtifactViewHost } from "./ArtifactViewHost";
import { ClaudeSessions, type AccountStatus } from "./sessions";
import type { ArtifactRef, Rect, ViewState } from "./types";

// The `eosArtifacts` bridge (preload/index.ts): claude.ai Artifacts as native
// views in the side panel and the hover peek (ArtifactViewHost), and the
// claude.ai web session of each Eos sign-in (sessions.ts). Only this Mac's own
// dashboard is answered — a controlled computer's view never gets the bridge,
// and main checks the sender too.

let host: ArtifactViewHost | null = null;

export function initArtifactHost(deps: {
  getWin: () => BrowserWindow | null;
  overlayPreload: string;
  covered?: () => boolean;
}): ArtifactViewHost {
  if (host) return host;
  const userData = app.getPath("userData");
  const sessions = new ClaudeSessions({ file: path.join(userData, "artifact-sessions.json"), parent: deps.getWin });
  const views = new ArtifactViewHost({
    getWin: deps.getWin,
    sessions,
    overlayPreload: deps.overlayPreload,
    stillsDir: path.join(userData, "artifact-stills"),
    covered: deps.covered,
  });
  host = views;
  // The old hover preview's screenshot cache (regenerable, superseded by the stills).
  void rm(path.join(userData, "artifact-previews"), { recursive: true, force: true }).catch(() => {});

  const fromDashboard = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => {
    const win = deps.getWin();
    return !!win && !win.isDestroyed() && e.sender.id === win.webContents.id;
  };
  const on = (channel: string, fn: (arg: Record<string, unknown>) => void): void => {
    ipcMain.on(channel, (e, arg: unknown) => {
      if (fromDashboard(e)) fn(arg && typeof arg === "object" ? (arg as Record<string, unknown>) : {});
    });
  };

  on("eosArtifacts:warm", (a) => {
    const ref = refOf(a.ref);
    if (ref) views.warm(ref);
  });
  on("eosArtifacts:peek", (a) => {
    const ref = refOf(a.ref);
    const rect = rectOf(a.rect);
    if (ref && rect) views.peek(ref, rect);
  });
  on("eosArtifacts:unpeek", () => views.unpeek());
  on("eosArtifacts:attach", (a) => {
    const tabKey = tabKeyOf(a.tabKey);
    const ref = refOf(a.ref);
    const rect = rectOf(a.rect);
    if (tabKey && ref && rect) views.attach(tabKey, ref, rect);
  });
  on("eosArtifacts:setBounds", (a) => {
    const tabKey = tabKeyOf(a.tabKey);
    const rect = rectOf(a.rect);
    if (tabKey && rect) views.setBounds(tabKey, rect);
  });
  on("eosArtifacts:setVisible", (a) => {
    const tabKey = tabKeyOf(a.tabKey);
    if (tabKey) views.setVisible(tabKey, a.visible === true);
  });
  on("eosArtifacts:detach", (a) => {
    const tabKey = tabKeyOf(a.tabKey);
    if (tabKey) views.detach(tabKey);
  });
  on("eosArtifacts:reload", (a) => {
    const slug = slugOf(a.slug);
    if (slug) views.reload(slug);
  });

  ipcMain.handle("eosArtifacts:still", async (e, ref: unknown): Promise<string | null> => {
    const r = fromDashboard(e) ? refOf(ref) : null;
    return r ? views.still(r) : null;
  });
  ipcMain.handle("eosArtifacts:state", (e, slug: unknown): ViewState => {
    const s = fromDashboard(e) ? slugOf(slug) : null;
    return s ? views.state(s) : "idle";
  });
  ipcMain.handle("eosArtifacts:account", async (e, arg: unknown): Promise<AccountStatus> => {
    const a = fromDashboard(e) ? accountArgs(arg) : null;
    return a ? sessions.account(a.loginId, a.expectedEmail) : { signedIn: false };
  });
  ipcMain.handle("eosArtifacts:signIn", async (e, arg: unknown): Promise<AccountStatus> => {
    const a = fromDashboard(e) ? accountArgs(arg) : null;
    return a ? sessions.signIn(a.loginId, a.expectedEmail) : { signedIn: false };
  });
  ipcMain.handle("eosArtifacts:signOut", async (e, loginId: unknown): Promise<void> => {
    if (fromDashboard(e)) await sessions.signOut(loginIdOf(loginId));
  });

  // A click on the peek's miniature; the host answers only its own views.
  ipcMain.on("artifactOverlay:action", (e, action: unknown) => views.overlayAction(e.sender, action));

  return views;
}

// The slug is always the artifact's uuid, and the only page a view loads is that
// uuid's viewer URL — never a URL the renderer sends.
function slugOf(raw: unknown): string | null {
  return typeof raw === "string" && shortIdOf(raw) ? raw.toLowerCase() : null;
}

function refOf(raw: unknown): ArtifactRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const slug = slugOf(r.slug) ?? (typeof r.url === "string" ? artifactSlugFromUrl(r.url) : null);
  if (!slug) return null;
  const ref: ArtifactRef = { slug, loginId: loginIdOf(r.loginId), url: artifactViewerUrl(slug) };
  if (typeof r.version === "string" && r.version) ref.version = r.version.slice(0, 128);
  if (typeof r.title === "string") ref.title = r.title.slice(0, 300);
  return ref;
}

function loginIdOf(raw: unknown): string | null {
  return typeof raw === "string" && raw ? raw.slice(0, 128) : null;
}

function rectOf(raw: unknown): Rect | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = [r.x, r.y, r.width, r.height];
  if (!n.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const [x, y, width, height] = n as number[];
  return { x: Math.round(x), y: Math.round(y), width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)) };
}

function tabKeyOf(raw: unknown): string | null {
  return typeof raw === "string" && raw.length > 0 && raw.length <= 256 ? raw : null;
}

function accountArgs(raw: unknown): { loginId: string | null; expectedEmail?: string } {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const email = typeof r.expectedEmail === "string" && r.expectedEmail.trim() ? r.expectedEmail.trim().slice(0, 320) : undefined;
  return email ? { loginId: loginIdOf(r.loginId), expectedEmail: email } : { loginId: loginIdOf(r.loginId) };
}
