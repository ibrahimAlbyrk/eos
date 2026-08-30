import { BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveUiRoot } from "./config";

// Launch splash — a small frameless glass panel (logo, "Eos", indeterminate bar),
// the ONE window where native vibrancy is correct (the main window stays opaque;
// doc 10 §e / plan §D8). macOS 26 uses NSGlassEffectView natively; Electron has
// no Liquid-Glass equivalent, so we ship the pre-26 fallback look (vibrancy
// "popover" + visualEffectState "active") on all versions and accept the delta.

function logoDataUri(): string {
  for (const p of [path.join(resolveUiRoot(), "logo.png"), path.join(resolveUiRoot(), "..", "public", "logo.png")]) {
    try {
      return `data:image/png;base64,${readFileSync(p).toString("base64")}`;
    } catch {
      /* try next */
    }
  }
  return "";
}

// Ports the Swift splash content + animations (main.swift:643-695): 64px logo with
// a 16px radius floating y 0→-5 (1.6s), "Eos" 16pt semibold kern 2.5, a 168×3 bar
// with an 84px blue highlight sweeping x -90→174 (1.25s). 30px panel radius.
function splashHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;-webkit-user-select:none;cursor:default;}
  .panel{position:fixed;inset:0;border-radius:30px;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:18px;background:rgba(18,18,20,0.20);}
  .logo{width:64px;height:64px;border-radius:16px;object-fit:cover;
    animation:floaty 1.6s ease-in-out infinite alternate;}
  .name{font:600 16px -apple-system,system-ui,sans-serif;color:#fff;letter-spacing:2.5px;}
  .bar{position:relative;width:168px;height:3px;border-radius:1.5px;
    background:rgba(255,255,255,0.18);overflow:hidden;}
  .bar::after{content:"";position:absolute;top:0;left:0;width:84px;height:3px;
    background:linear-gradient(90deg,transparent,rgba(107,158,255,1),transparent);
    animation:sweep 1.25s ease-in-out infinite;}
  @keyframes floaty{from{transform:translateY(0)}to{transform:translateY(-5px)}}
  @keyframes sweep{from{transform:translateX(-90px)}to{transform:translateX(174px)}}
  </style></head><body><div class="panel">
    <img class="logo" src="${logoDataUri()}"/><div class="name">Eos</div><div class="bar"></div>
  </div></body></html>`;
}

export function createSplash(): BrowserWindow {
  const win = new BrowserWindow({
    width: 280,
    height: 200,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: true,
    roundedCorners: true,
    vibrancy: "popover", // §D8: the pre-26 fallback material
    visualEffectState: "active", // stay lit (it shows for seconds)
    alwaysOnTop: true,
    center: true,
    show: false,
    skipTaskbar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // skipTransformProcessType: WITHOUT it, setVisibleOnAllWorkspaces transforms the
  // app's macOS process type ForegroundApplication→UIElementApplication (accessory),
  // which HIDES the Dock icon — and it never transforms back, so the Dock stays gone
  // for the whole session once this boot splash appears. Skipping the transform keeps
  // the all-spaces collection behavior (splash still shows over fullscreen) while
  // leaving the app a regular Dock-owning app.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(splashHtml()));
  win.once("ready-to-show", () => win.show());
  return win;
}

// Grow 1.32× + fade over ~0.5s, then close (main.swift finishSplashThenLoadWeb).
export function dismissSplash(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const b = win.getBounds();
  const gx = Math.round(b.x - b.width * 0.16);
  const gy = Math.round(b.y - b.height * 0.16);
  const gw = Math.round(b.width * 1.32);
  const gh = Math.round(b.height * 1.32);
  const steps = 15;
  let i = 0;
  const t = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(t);
    i++;
    const f = i / steps;
    win.setBounds({
      x: Math.round(b.x + (gx - b.x) * f),
      y: Math.round(b.y + (gy - b.y) * f),
      width: Math.round(b.width + (gw - b.width) * f),
      height: Math.round(b.height + (gh - b.height) * f),
    });
    win.setOpacity(1 - f);
    if (i >= steps) {
      clearInterval(t);
      if (!win.isDestroyed()) win.close();
    }
  }, 500 / steps);
}
