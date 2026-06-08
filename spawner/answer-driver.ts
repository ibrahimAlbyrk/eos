// AnswerDriver — answers Claude's native AskUserQuestion menu with verified
// keystroke choreography, mirroring delivery.ts/rewind.ts's evidence-over-timers
// rule. Replaces the old interrupt(Esc)+message fallback whose Esc CANCELLED the
// menu, making the agent receive a "tool was rejected" result before the answer
// ("answered without me" bug).
//
// Protocol empirically verified on claude 2.1.168 (scripts/probe/auq-probe.mjs,
// authoritative transcript tool_result). Menu rows per question: real options
// 1..N, then an auto-appended "Type something." (free text) at N+1, then
// "Chat about this" at N+2 — selecting that REJECTS. Footer:
// "Enter to select · ↑/↓ navigate · Esc cancel".
//   - single-select pick K (0-based): down×K + Enter  (Enter records + submits,
//     or auto-advances to the next question in a multi-question menu).
//   - single-select free text: down×N to HIGHLIGHT "Type something." (do NOT
//     press Enter — that opens a Vim edit mode that mis-submits), type directly,
//     then Enter.
//   - multi-select: per pick, down-to-it + Enter (toggles); free text same as
//     above without the trailing Enter; then Right (moves to the Submit tab).
//   - a final Enter submits, except a single single-select question already
//     submitted on its own Enter.

import { normalizeForMatch } from "./delivery.ts";

export interface AnswerSpec {
  multiSelect: boolean;
  /** Count of REAL options (excludes the auto "Type something."/"Chat about this"). */
  optionCount: number;
  /** 0-based indices of chosen real options, display order. Empty if free-text only. */
  picks: number[];
  /** Present ⇒ the user chose "Other"; the literal text to type. */
  freeText?: string;
}

export type Step = { key: string } | { text: string };

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const CR = "\r";

/**
 * Deterministic key sequence for a set of answered questions. Pure + exported so
 * the protocol is unit-tested against the verified probe sequences.
 */
export function buildKeySequence(answers: AnswerSpec[]): Step[] {
  const steps: Step[] = [];
  const n = answers.length;

  for (const a of answers) {
    let cursor = 0;
    const down = (to: number): void => { while (cursor < to) { steps.push({ key: DOWN }); cursor++; } };

    if (a.multiSelect) {
      for (const t of [...a.picks].sort((x, y) => x - y)) {
        down(t);
        steps.push({ key: CR }); // toggle checkbox
      }
      if (a.freeText != null) {
        down(a.optionCount); // highlight "Type something."
        steps.push({ text: a.freeText });
      }
      steps.push({ key: RIGHT }); // advance to the next tab / Submit
    } else if (a.freeText != null) {
      down(a.optionCount); // highlight "Type something." — type directly, no Enter
      steps.push({ text: a.freeText });
      steps.push({ key: CR });
    } else {
      down(a.picks[0] ?? 0);
      steps.push({ key: CR }); // records + submits (single question) or auto-advances
    }
  }

  // A lone single-select question submits on its own Enter; everything else
  // (multi-select's Right, or a multi-question menu) lands on the Submit tab.
  const lastSubmits = n === 1 && !answers[0].multiSelect;
  if (!lastSubmits) steps.push({ key: CR });

  return steps;
}

export type AnswerOutcome = "answered" | "unverified" | "no_menu";

export interface AnswerDriverDeps {
  write(s: string): void;
  /** Wall-clock ms of the most recent tool_result seen in the transcript. While a
   *  menu is being driven, the next tool_result IS the AUQ answer — so a value
   *  greater than the drive's start time confirms the answer landed. */
  lastToolResultTs(): number;
  log?(msg: string): void;
  setTimer?: typeof setTimeout;
  now?(): number;
  timeouts?: Partial<{ settleMs: number; keyGapMs: number; verifyMs: number }>;
}

// Timing tuned by a descending sweep on claude 2.1.168 (scripts/probe/auq-probe.mjs)
// over the hardest menus (3-question auto-advance, 4-option multi-select with
// navigation, free-text typing). The floor is settle=8/gap=2 (3-question answers
// dropped a question / got rejected there); settle=18/gap=6 is two ticks above it
// and passed 8/8 incl. the cases that broke at the floor. In production the menu
// has been open for seconds (the banner was showing) before the user submits, so
// it tolerates fast driving even better than the probe's drive-on-render race.
// A 3-question answer now drives in ~42ms (keystrokes); end-to-end POST latency
// is dominated by Claude writing the tool_result, not by us.
const SETTLE_BEFORE_MS = 18;
const KEY_GAP_MS = 6;
const VERIFY_TIMEOUT_MS = 9000;

// Normalized menu-footer fragments — present in the PTY exactly while a menu is
// rendered, absent from the prompt echo. Any one ⇒ a menu is on screen.
const MENU_FRAGMENTS = ["Esctocancel", "tonavigate", "Entertoselect"];

export class AnswerDriver {
  private readonly deps: AnswerDriverDeps;
  private readonly setT: typeof setTimeout;
  private screen = "";
  private menu = false;
  private running = false;

  constructor(deps: AnswerDriverDeps) {
    this.deps = deps;
    this.setT = deps.setTimer ?? setTimeout;
  }

  /** PTY output → menu-open detector (best-effort; biased toward "open"). */
  feed(chunk: string): void {
    this.screen = (this.screen + chunk).slice(-6000);
    const norm = normalizeForMatch(this.screen);
    if (MENU_FRAGMENTS.some((f) => norm.includes(f))) this.menu = true;
  }

  /** A menu is currently rendered — hold deliveries / block stray Esc. */
  get menuOpen(): boolean { return this.menu || this.running; }
  get active(): boolean { return this.running; }

  /** Force-clear after the menu is known closed (answer landed / explicit cancel). */
  close(): void { this.menu = false; this.screen = ""; }

  async answer(answers: AnswerSpec[]): Promise<AnswerOutcome> {
    if (this.running) return "unverified";
    this.running = true;
    const t = this.deps.timeouts ?? {};
    const now = this.deps.now ?? Date.now;
    const since = now();
    try {
      await this.sleep(t.settleMs ?? SETTLE_BEFORE_MS);
      for (const step of buildKeySequence(answers)) {
        this.deps.write("key" in step ? step.key : step.text);
        await this.sleep(t.keyGapMs ?? KEY_GAP_MS);
      }
      const ok = await this.waitAnswerLanded(since, t.verifyMs ?? VERIFY_TIMEOUT_MS);
      this.close();
      if (!ok) this.deps.log?.("answer delivered but no tool_result observed (unverified)");
      return ok ? "answered" : "unverified";
    } finally {
      this.running = false;
    }
  }

  private async waitAnswerLanded(since: number, timeoutMs: number): Promise<boolean> {
    const now = this.deps.now ?? Date.now;
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      if (this.deps.lastToolResultTs() > since) return true;
      await this.sleep(200);
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.setT(resolve, ms); });
  }
}
