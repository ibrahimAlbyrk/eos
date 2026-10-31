import { nativeImage } from "electron";
import type { NativeImage } from "electron";
import type { StillStore } from "./stills";
import { later, type Entry } from "./types";

const STILL_SETTLE_MS = 1500;
const STILL_MAX_WIDTH = 1600;
const STILL_QUALITY = 72;
const CAPTURE_TIMEOUT_MS = 6000;

export interface StillHooks {
  // The load's still is in (or already was): a hidden view may throttle now.
  done(e: Entry): void;
  // A fresh still was written while the view is ready.
  written(e: Entry): void;
}

// Takes each load's still once the page has settled.
export class StillCapture {
  private readonly store: StillStore;
  private readonly hooks: StillHooks;

  constructor(store: StillStore, hooks: StillHooks) {
    this.store = store;
    this.hooks = hooks;
  }

  // A versioned still never goes stale, so one already on disk is kept unless
  // this load was a reload.
  async prepare(e: Entry): Promise<void> {
    const seq = e.seq;
    const keep = !e.recapture && e.ref.version != null && (await this.store.has(e.slug, e.ref.version));
    if (e.disposed || e.seq !== seq) return;
    if (keep) this.finish(e);
    else this.schedule(e);
  }

  schedule(e: Entry): void {
    const seq = e.seq;
    later(e, STILL_SETTLE_MS, () => void this.take(e, seq));
  }

  private async take(e: Entry, seq: number): Promise<void> {
    if (e.disposed || e.seq !== seq || e.state !== "ready") return;
    // The miniature is zoomed out — take the still once the peek ends.
    if (e.placement.kind === "peek") {
      e.stillDue = true;
      return;
    }
    try {
      const jpeg = await this.capture(e);
      if (jpeg && !e.disposed && e.seq === seq) {
        await this.store.write(e.slug, e.ref.version, jpeg);
        if (e.state === "ready") this.hooks.written(e);
      }
    } catch (err) {
      console.error("[eos-artifacts] still failed:", err instanceof Error ? err.message : String(err));
    }
    if (!e.disposed && e.seq === seq) this.finish(e);
  }

  private finish(e: Entry): void {
    e.capturing = false;
    e.recapture = false;
    e.stillDue = false;
    this.hooks.done(e);
  }

  // capturePage() has pixels only for a view on screen; a hidden one is shot over CDP.
  private async capture(e: Entry): Promise<Buffer | null> {
    const wc = e.view.webContents;
    if (e.shown) {
      const img = await wc.capturePage();
      if (!img.isEmpty()) return toStill(img);
    }
    const dbg = wc.debugger;
    let attached = false;
    try {
      if (!dbg.isAttached()) {
        dbg.attach("1.3");
        attached = true;
      }
      const shot = (await withTimeout(
        dbg.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: STILL_QUALITY }),
        CAPTURE_TIMEOUT_MS,
      )) as { data?: string };
      if (!shot?.data) return null;
      const bytes = Buffer.from(shot.data, "base64");
      const img = nativeImage.createFromBuffer(bytes);
      if (img.isEmpty()) return null;
      return img.getSize().width > STILL_MAX_WIDTH ? toStill(img) : bytes;
    } finally {
      if (attached) {
        try { dbg.detach(); } catch { /* already detached */ }
      }
    }
  }
}

function toStill(img: NativeImage): Buffer {
  const { width } = img.getSize();
  const sized = width > STILL_MAX_WIDTH ? img.resize({ width: STILL_MAX_WIDTH, quality: "good" }) : img;
  return sized.toJPEG(STILL_QUALITY);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("capture timed out")), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))); },
    );
  });
}
