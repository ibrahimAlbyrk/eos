// Rewind — drives Claude's native TUI rewind panel (double-Esc) with verified
// keystroke choreography, mirroring delivery.ts's evidence-over-timers rule.
//
// Empirically verified against claude 2.1.168 (see the constants below):
//   - Esc,Esc on an EMPTY composer opens the panel; with text the same pair
//     CLEARS the text instead — so openPanel() retries once, which covers both.
//   - The list shows user prompts oldest→newest with a "(current)" sentinel
//     row at the bottom where the cursor starts; ↑×k selects the k-th prompt
//     from the end. Multi-line prompts render as one ellipsized row, so the
//     verification needle must come from the first line only.
//   - The confirm submenu is NUMBERED and digit keys execute immediately.
//     "Restore code and conversation"/"Restore code" only appear when the
//     selected message has file checkpoints — option digits shift accordingly.
//   - Restoring NEVER truncates the JSONL: Claude forks in memory and the next
//     submit branches via parentUuid. The restored prompt lands in the TUI
//     composer; it MUST be cleared (Ctrl+U kills the whole multi-line input)
//     or the next delivery would submit it concatenated with the new text.
//   - Incremental Ink repaints skip already-painted cells, so screen waits
//     match on "≥2 of N fragments" instead of one contiguous marker.

import { normalizeForMatch } from "./delivery.ts";
import { computeRewindTargets, type RewindTarget } from "../core/src/domain/rewind-targets.ts";

// The pure transcript walk (computeRewindTargets + its RewindTarget shape) lives
// in core/src/domain/rewind-targets.ts so the claude-sdk lane shares it; re-export
// here so this module stays the spawner's single rewind surface.
export { computeRewindTargets };
export type { RewindTarget };

export type RewindMode = "conversation" | "code" | "both";

export type RewindOutcome =
  // `index` = target's 0-based position among active-branch prompts — the web
  // chat uses it as a fallback cut point when text matching fails.
  | { ok: true; uuid: string; text: string; display: string; index: number }
  | { ok: false; error: string };

const ESC = "\x1b";
const UP = "\x1b[A";
const CR = "\r";
const CTRL_U = "\x15";

const ESC_GAP_MS = 300;
const KEY_GAP_MS = 80;
const PANEL_TIMEOUT_MS = 3000;
const ROW_VERIFY_TIMEOUT_MS = 1500;
const SUBMENU_TIMEOUT_MS = 3000;
// Restore repaints can be lazy (observed: no output until the next keystroke),
// so completion is a fixed settle, not an output wait.
const POST_RESTORE_MS = 700;
const CLEANUP_GAP_MS = 250;
const SCREEN_BUF_CAP = 16384;
const NEEDLE_LEN = 16;
const MIN_NEEDLE_LEN = 3;

// Normalized (whitespace/ANSI/box-drawing stripped) fragments. Each set is
// specific enough that any 2 together identify the screen.
export const PANEL_FRAGMENTS = [
  "Rewind",
  "(current)",
  "Esctocancel",
  "Entertocontinue",
  "Nocodechanges",
  "moreabove",
  "morebelow",
];
export const SUBMENU_FRAGMENTS = [
  "youwant",
  "torestore",
  "thepoint",
  "willbeforked",
  "Nevermind",
  "Summarize",
];
const SUBMENU_CODE_OPTION = "Restorecodeandconversation";

export function countFragments(normScreen: string, fragments: string[]): number {
  return fragments.filter((f) => normScreen.includes(f)).length;
}

/** Verification needle for a panel row: first line only (rows ellipsize at the
 *  line break), normalized, prefix-truncated (rows clip at the right edge). */
export function rowNeedle(display: string): string | null {
  const firstLine = display.split("\n", 1)[0] ?? "";
  const n = normalizeForMatch(firstLine).slice(0, NEEDLE_LEN);
  return n.length >= MIN_NEEDLE_LEN ? n : null;
}

// ---- driver -----------------------------------------------------------------

export interface RewindDriverDeps {
  write(s: string): void;
  readTranscript(): string | null;
  /** Delivery in flight or a turn open — keystrokes would interleave. */
  isBusy(): boolean;
  log?(msg: string): void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

interface ScreenWait {
  check(norm: string): boolean;
  resolve(hit: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

export class RewindDriver {
  private readonly deps: RewindDriverDeps;
  private readonly setT: typeof setTimeout;
  private readonly clearT: typeof clearTimeout;
  private buf = "";
  private capturing = false;
  private wait: ScreenWait | null = null;
  private running = false;

  constructor(deps: RewindDriverDeps) {
    this.deps = deps;
    this.setT = deps.setTimer ?? setTimeout;
    this.clearT = deps.clearTimer ?? clearTimeout;
  }

  get active(): boolean {
    return this.running;
  }

  /** PTY output → screen matcher. No-op unless a rewind is in progress. */
  feed(chunk: string): void {
    if (!this.capturing) return;
    this.buf = (this.buf + chunk).slice(-SCREEN_BUF_CAP);
    if (this.wait) {
      const w = this.wait;
      if (w.check(normalizeForMatch(this.buf))) {
        this.wait = null;
        this.clearT(w.timer);
        w.resolve(true);
      }
    }
  }

  targets(): RewindTarget[] {
    const jsonl = this.deps.readTranscript();
    return jsonl ? computeRewindTargets(jsonl) : [];
  }

  async rewind(uuid: string, mode: RewindMode): Promise<RewindOutcome> {
    if (this.running) return { ok: false, error: "rewind already in progress" };
    if (this.deps.isBusy()) return { ok: false, error: "delivery in progress — try again when idle" };
    const jsonl = this.deps.readTranscript();
    if (!jsonl) return { ok: false, error: "no session transcript yet" };
    const targets = computeRewindTargets(jsonl);
    const targetIndex = targets.findIndex((t) => t.uuid === uuid);
    if (targetIndex < 0) return { ok: false, error: "message not found on the active branch" };
    const target = targets[targetIndex];

    this.running = true;
    this.capturing = true;
    this.buf = "";
    try {
      if (!(await this.openPanel())) {
        this.deps.write(ESC);
        return { ok: false, error: "rewind panel did not open" };
      }

      // Navigate: cursor starts on the bottom "(current)" row; ↑×upCount lands
      // on the target. Buffer is cleared before the LAST press so the verify
      // needle can only match the final highlight repaint, not scrollback.
      for (let i = 0; i < target.upCount; i++) {
        if (i === target.upCount - 1) this.buf = "";
        this.deps.write(UP);
        await this.sleep(KEY_GAP_MS);
      }
      const needle = rowNeedle(target.display);
      if (needle) {
        const okRow = await this.waitScreen(
          (n) => n.includes("❯" + needle) || n.includes(needle),
          ROW_VERIFY_TIMEOUT_MS,
        );
        if (!okRow) {
          await this.dismiss(1);
          return { ok: false, error: "selected row did not match the expected message" };
        }
      }

      this.buf = "";
      this.deps.write(CR);
      const submenuOk = await this.waitScreen(
        (n) => countFragments(n, SUBMENU_FRAGMENTS) >= 2,
        SUBMENU_TIMEOUT_MS,
      );
      if (!submenuOk) {
        await this.dismiss(1);
        return { ok: false, error: "restore menu did not open" };
      }

      // Digits shift when the message has file checkpoints:
      //   with code:    1=code+conversation 2=conversation 3=code …
      //   without code: 1=conversation …
      const hasCode = normalizeForMatch(this.buf).includes(SUBMENU_CODE_OPTION);
      const digit =
        mode === "conversation" ? (hasCode ? "2" : "1")
        : mode === "both" ? "1" // without checkpoints option 1 is conversation-only — equivalent, code is unchanged
        : hasCode ? "3" : null;
      if (!digit) {
        await this.dismiss(2);
        return { ok: false, error: "no code checkpoint exists for this message" };
      }
      this.deps.write(digit);
      await this.sleep(POST_RESTORE_MS);

      // The restored prompt sits in the TUI composer; the web composer takes
      // over, so kill it (twice — harmless no-op when already empty). Esc is
      // NOT safe here: it is stateful and a pair would reopen the panel.
      this.deps.write(CTRL_U);
      await this.sleep(150);
      this.deps.write(CTRL_U);

      this.deps.log?.(`rewound to ${target.uuid} (${mode})`);
      return { ok: true, uuid: target.uuid, text: target.text, display: target.display, index: targetIndex };
    } finally {
      this.running = false;
      this.capturing = false;
      this.buf = "";
      if (this.wait) {
        this.clearT(this.wait.timer);
        this.wait.resolve(false);
        this.wait = null;
      }
    }
  }

  /** Esc,Esc opens the panel only when the composer is empty; when it held
   *  text the first pair cleared it, so one retry covers both states. */
  private async openPanel(): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.buf = "";
      this.deps.write(ESC);
      await this.sleep(ESC_GAP_MS);
      this.deps.write(ESC);
      const ok = await this.waitScreen(
        (n) => countFragments(n, PANEL_FRAGMENTS) >= 2,
        PANEL_TIMEOUT_MS,
      );
      if (ok) return true;
    }
    return false;
  }

  /** Close panel/submenu after a failure: Esc per open layer. */
  private async dismiss(layers: number): Promise<void> {
    for (let i = 0; i < layers; i++) {
      this.deps.write(ESC);
      await this.sleep(CLEANUP_GAP_MS);
    }
  }

  private waitScreen(check: (norm: string) => boolean, timeoutMs: number): Promise<boolean> {
    if (check(normalizeForMatch(this.buf))) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = this.setT(() => {
        this.wait = null;
        resolve(false);
      }, timeoutMs);
      this.wait = { check, resolve, timer };
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.setT(resolve, ms); });
  }
}
