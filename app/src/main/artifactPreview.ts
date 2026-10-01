import { app, BrowserWindow, ipcMain, session as electronSession } from "electron";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

// Artifact link previews: Eos renders a published claude.ai artifact in its OWN
// persistent claude.ai session (never another browser's cookies) and hands the
// renderer a JPEG to show in the hover card. The session is a plain Electron
// partition the user signs into once; nothing is read from the user's Chrome/
// Arc/Safari stores.
//
// Only this app (not a controlled computer's view) gets the bridge — the login
// and the render happen on THIS Mac.

const PARTITION = "persist:eos-claude";
const VIEWPORT = { width: 1200, height: 760 };
const SETTLE_MS = 2600; // after load, let the artifact's sandboxed iframe paint
const LOAD_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 10 * 60 * 1000; // re-capture a given page at most this often
const ARTIFACT_URL = /^https:\/\/(?:preview\.)?claude\.(?:ai|com)\/(?:code\/)?artifact\/[A-Za-z0-9-]+(?:[/?#][^\s]*)?$/;

type PreviewResult =
  | { state: "ready"; dataUrl: string }
  | { state: "signin" }
  | { state: "unavailable" }
  | { state: "error" };

const mem = new Map<string, { at: number; dataUrl: string }>();
const inflight = new Map<string, Promise<PreviewResult>>();

function claudeSession() {
  return electronSession.fromPartition(PARTITION);
}

async function isSignedIn(): Promise<boolean> {
  try {
    const cookies = await claudeSession().cookies.get({ domain: "claude.ai" });
    return cookies.some((c) => c.name === "sessionKey" && Boolean(c.value));
  } catch {
    return false;
  }
}

function cacheFile(url: string): string {
  const h = createHash("sha256").update(url).digest("hex").slice(0, 32);
  return path.join(app.getPath("userData"), "artifact-previews", `${h}.jpg`);
}

async function readDiskCache(url: string): Promise<string | null> {
  try {
    const file = cacheFile(url);
    const info = await stat(file);
    if (Date.now() - info.mtimeMs > CACHE_TTL_MS) return null;
    const bytes = await readFile(file);
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

async function persist(url: string, dataUrl: string): Promise<void> {
  try {
    const file = cacheFile(url);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(dataUrl.split(",")[1] ?? "", "base64"));
  } catch (e) {
    console.error("[eos-artifact-preview] cache write failed:", e instanceof Error ? e.message : String(e));
  }
}

// Render the page in a hidden window in the claude.ai session and grab a JPEG.
// capturePage() is empty for a never-shown window, so capture over CDP
// (Page.captureScreenshot) exactly as the embedded-browser driver does for an
// off-screen tab. A redirect to /login means this session can't open the page.
async function captureUrl(url: string): Promise<{ dataUrl: string } | { signin: true }> {
  const win = new BrowserWindow({
    show: false,
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    webPreferences: {
      session: claudeSession(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const dbg = win.webContents.debugger;
  try {
    const loaded = new Promise<void>((resolve) => {
      win.webContents.once("did-finish-load", () => resolve());
      win.webContents.once("did-fail-load", () => resolve());
      setTimeout(resolve, LOAD_TIMEOUT_MS);
    });
    await win.loadURL(url).catch(() => {});
    await loaded;
    if (/\/login\b/.test(win.webContents.getURL())) return { signin: true };
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    try { dbg.attach("1.3"); } catch { /* already attached */ }
    const shot = (await dbg.sendCommand("Page.captureScreenshot", {
      format: "jpeg",
      quality: 72,
      captureBeyondViewport: false,
    })) as { data: string };
    return { dataUrl: `data:image/jpeg;base64,${shot.data}` };
  } finally {
    try { if (dbg.isAttached()) dbg.detach(); } catch { /* ignore */ }
    if (!win.isDestroyed()) win.destroy();
  }
}

async function getPreview(url: string): Promise<PreviewResult> {
  if (!ARTIFACT_URL.test(url)) return { state: "unavailable" };

  const cached = mem.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { state: "ready", dataUrl: cached.dataUrl };
  if (inflight.has(url)) return inflight.get(url) as Promise<PreviewResult>;

  const run = (async (): Promise<PreviewResult> => {
    try {
      const disk = await readDiskCache(url);
      if (disk) {
        mem.set(url, { at: Date.now(), dataUrl: disk });
        return { state: "ready", dataUrl: disk };
      }
      if (!(await isSignedIn())) return { state: "signin" };
      const shot = await captureUrl(url);
      if ("signin" in shot) return { state: "signin" };
      mem.set(url, { at: Date.now(), dataUrl: shot.dataUrl });
      void persist(url, shot.dataUrl);
      return { state: "ready", dataUrl: shot.dataUrl };
    } catch (e) {
      console.error("[eos-artifact-preview] capture failed:", e instanceof Error ? e.message : String(e));
      return { state: "error" };
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, run);
  return run;
}

// A visible one-off window on claude.ai's login; resolves once the session holds
// a sign-in cookie (or the user closes it). One at a time.
let loginWin: BrowserWindow | null = null;
async function openLogin(parent: BrowserWindow | null): Promise<boolean> {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus();
  } else {
    loginWin = new BrowserWindow({
      parent: parent ?? undefined,
      width: 460,
      height: 720,
      resizable: true,
      title: "Sign in to claude.ai",
      webPreferences: { session: claudeSession(), contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    loginWin.on("closed", () => { loginWin = null; });
    await loginWin.loadURL("https://claude.ai/login").catch(() => {});
  }
  const win = loginWin;
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      const ok = await isSignedIn();
      if (!ok && win && !win.isDestroyed()) return; // keep polling until signed in or closed
      done = true;
      clearInterval(timer);
      if (ok && win && !win.isDestroyed()) win.close();
      resolve(ok);
    };
    const timer = setInterval(finish, 1000);
    win?.on("closed", () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      void isSignedIn().then(resolve);
    });
  });
}

let registered = false;
export function initArtifactPreview(getWin: () => BrowserWindow | null): void {
  if (registered) return;
  registered = true;
  ipcMain.handle("artifactPreview:status", async () => ({ signedIn: await isSignedIn() }));
  ipcMain.handle("artifactPreview:get", async (_e, url: unknown) =>
    typeof url === "string" ? getPreview(url) : ({ state: "unavailable" } satisfies PreviewResult),
  );
  ipcMain.handle("artifactPreview:connect", async () => {
    const signedIn = await openLogin(getWin());
    if (signedIn) mem.clear(); // a fresh sign-in may open pages the old one couldn't
    return { signedIn };
  });
}
