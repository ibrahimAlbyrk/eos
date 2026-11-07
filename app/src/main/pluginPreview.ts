import { BrowserWindow } from "electron";
import { PLUGIN_PREVIEW_SIZES, type PluginPreviewResult, type PluginPreviewSurface } from "../../../contracts/src/plugin";

// The daemon's "plugin.preview" RPC (plugin_preview tool): draw one plugin
// surface in a hidden, offscreen window of the dashboard's own bundle — real
// styles and fonts, but none of the user's windows, and stored values only read —
// and hand back a PNG. The page side is app/ui/src/plugins/preview.jsx.

const TIMEOUT_MS = 25_000; // under the daemon's 30 s RPC timeout

interface PreviewArgs {
  surface?: PluginPreviewSurface;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface PreviewDeps {
  preload: string;
  additionalArguments: string[];
}

// One at a time: each preview is a whole renderer.
let queue: Promise<unknown> = Promise.resolve();

export function renderPluginPreview(deps: PreviewDeps, args: PreviewArgs): Promise<PluginPreviewResult> {
  const run = queue.then(() => render(deps, args));
  queue = run.catch(() => {});
  return run;
}

async function render(deps: PreviewDeps, args: PreviewArgs): Promise<PluginPreviewResult> {
  // The surface's size is only known once the page sees what the plugin registered,
  // so the window starts at the asked (or main) size and the page reports the size it drew.
  const [w, h] = PLUGIN_PREVIEW_SIZES[args.surface ?? "main"];
  const win = new BrowserWindow({
    show: false,
    width: args.width ?? w,
    height: args.height ?? h,
    useContentSize: true,
    webPreferences: {
      preload: deps.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      offscreen: true,
      backgroundThrottling: false,
      additionalArguments: deps.additionalArguments,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      await win.loadURL("eos://app/index.html#plugin-preview");
      const drawn = (await win.webContents.executeJavaScript(
        `(async () => {
          for (let i = 0; i < 300 && !window.__eosPluginPreview; i++) await new Promise((r) => setTimeout(r, 50));
          if (!window.__eosPluginPreview) throw new Error("the preview page did not start");
          return window.__eosPluginPreview(${JSON.stringify({ ...args, sizes: PLUGIN_PREVIEW_SIZES })});
        })()`,
      )) as Omit<PluginPreviewResult, "png">;
      if (drawn.width !== win.getContentSize()[0] || drawn.height !== win.getContentSize()[1]) {
        win.setContentSize(drawn.width, drawn.height);
        await win.webContents.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
      }
      const image = await win.webContents.capturePage();
      if (image.isEmpty()) throw new Error("the preview window drew nothing");
      return { ...drawn, png: image.toPNG().toString("base64") };
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the preview took too long to draw")), TIMEOUT_MS);
    });
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    win.destroy();
  }
}
