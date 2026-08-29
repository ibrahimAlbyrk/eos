import { Tray, Menu, nativeImage, nativeTheme } from "electron";
import type { WebContents, NativeImage } from "electron";
import { renderTrayImage } from "./tray-paint";
import type { Completion } from "./fleet";

const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

interface TrayHooks {
  wc: () => WebContents | null;
  showWindow: () => void;
  quit: () => void;
}

// Owns the retained Tray, the breathing-star animation, and the completion pill.
// Trays can't host a live view, so frames are canvas-rendered nativeImages pushed
// on a timer (plan §E3 R5) — the single largest re-implementation from the Swift
// StatusItemController/RunningAnimator.
export class TrayController {
  private tray: Tray | null = null;
  private reduceMotion = false;
  private playingPill = false;
  private breathTimer: ReturnType<typeof setInterval> | null = null;
  private pillTimer: ReturnType<typeof setInterval> | null = null;
  private gen = 0; // cancels stale async frame renders
  private last = { running: false, count: 0, connected: true };

  constructor(private readonly hooks: TrayHooks) {}

  async init(): Promise<void> {
    const wc = this.hooks.wc();
    if (wc) {
      this.reduceMotion =
        (await wc.executeJavaScript("window.matchMedia('(prefers-reduced-motion: reduce)').matches", true).catch(
          () => false,
        )) === true;
    }
    const idle =
      (wc && (await renderTrayImage(wc, { mode: "icon", running: false, count: 0, connected: true, scale: 1, opacity: 1 }))) ||
      nativeImage.createEmpty();
    this.tray = new Tray(idle);
    this.tray.setToolTip("Eos agents");
    this.tray.on("click", () => this.hooks.showWindow());
    this.tray.on("right-click", () => this.popMenu());
  }

  private popMenu(): void {
    const menu = Menu.buildFromTemplate([
      { label: "Open Eos", click: () => this.hooks.showWindow() },
      { type: "separator" },
      { label: "Quit Eos", click: () => this.hooks.quit() },
    ]);
    this.tray?.popUpContextMenu(menu);
  }

  private setImage(img: import("electron").NativeImage | null): void {
    if (img && this.tray) this.tray.setImage(img);
  }

  private clearTimers(): void {
    if (this.breathTimer) clearInterval(this.breathTimer);
    if (this.pillTimer) clearInterval(this.pillTimer);
    this.breathTimer = this.pillTimer = null;
  }

  // Fleet running state → idle star / breathing star + count. Ignored while a
  // pill is playing (the running face resumes on drain, matching Swift).
  async renderRunning(running: boolean, count: number, connected: boolean): Promise<void> {
    this.last = { running, count, connected };
    if (this.playingPill) return;
    const wc = this.hooks.wc();
    if (!wc) return;
    const gen = ++this.gen;
    this.clearTimers();

    if (running && connected && !this.reduceMotion) {
      // Pre-render the breath half-cycle, then ping-pong at the breath tempo
      // (breath = max(1.25, 1.9 - count*0.09); Swift RunningAnimator).
      const N = 14;
      const frames: NativeImage[] = [];
      for (let i = 0; i < N; i++) {
        const e = ease(i / (N - 1));
        const img = await renderTrayImage(wc, {
          mode: "icon",
          running: true,
          count,
          connected,
          scale: 0.9 + 0.16 * e,
          opacity: 0.78 + 0.22 * e,
        });
        if (gen !== this.gen) return; // superseded
        if (img) frames.push(img);
      }
      if (!frames.length) return;
      const breath = Math.max(1.25, 1.9 - count * 0.09);
      const interval = Math.max(30, ((breath / 2) / (N - 1)) * 1000);
      let idx = 0;
      let dir = 1;
      this.setImage(frames[0]);
      this.breathTimer = setInterval(() => {
        idx += dir;
        if (idx >= frames.length - 1) dir = -1;
        else if (idx <= 0) dir = 1;
        this.setImage(frames[idx]);
      }, interval);
    } else {
      const img = await renderTrayImage(wc, { mode: "icon", running, count, connected, scale: 1, opacity: 1 });
      if (gen === this.gen) this.setImage(img);
    }
  }

  // Completion toast with a draining underline, played over `dwellMs`.
  async announce(c: Completion, remaining: number, dwellMs: number): Promise<void> {
    this.playingPill = true;
    const wc = this.hooks.wc();
    if (!wc) return;
    const gen = ++this.gen;
    this.clearTimers();
    const dark = nativeTheme.shouldUseDarkColors;
    const suffix = c.failed ? "failed" : "done";
    const M = 16;
    const frames: NativeImage[] = [];
    for (let i = 0; i < M; i++) {
      const img = await renderTrayImage(wc, {
        mode: "pill",
        name: c.name,
        suffix,
        failed: c.failed,
        remaining,
        drain: 1 - i / (M - 1),
        dark,
      });
      if (gen !== this.gen) return;
      if (img) frames.push(img);
    }
    if (!frames.length) return;
    let idx = 0;
    this.setImage(frames[0]);
    if (this.reduceMotion) return; // hold the full pill, no drain animation
    const interval = Math.max(60, dwellMs / M);
    this.pillTimer = setInterval(() => {
      idx = Math.min(idx + 1, frames.length - 1);
      this.setImage(frames[idx]);
    }, interval);
  }

  // Queue drained → resume the running face.
  drained(running: boolean, count: number): void {
    this.playingPill = false;
    void this.renderRunning(running, count, this.last.connected);
  }

  destroy(): void {
    this.clearTimers();
    this.tray?.destroy();
    this.tray = null;
  }
}
