// DeliveryPipeline — verified PTY message delivery. Replaces the old
// PtyWriteQueue's blind text→300ms→CR timing with evidence-driven stages:
//
//   1. paste   — text wrapped in explicit bracketed-paste markers in ONE write,
//                so Ink's paste semantics never depend on chunk timing and the
//                autocomplete popup (which swallows Enter) never opens.
//   2. echo    — wait until the composer echoes the text back in the PTY output
//                (normalized match) instead of sleeping a fixed delay. Claude's
//                bracketed-paste mode swallows a CR that arrives in the same
//                write as text; the echo proves the paste was consumed. If the
//                echo never shows, fall back to the legacy fixed delay — the
//                worst case is exactly the old behavior.
//   3. submit  — CR.
//   4. turn-ACK— the message appearing as a user entry in the transcript JSONL
//                is the only end-to-end proof Claude accepted the turn.
//
// Retry ladder (designed so a duplicate send is impossible):
//   echo OK + ACK OK    → delivered.
//   echo OK + no ACK    → ONE re-CR (a swallowed CR is the only plausible
//                         failure left; an empty re-submit is harmless), then
//                         resolve "unverified" — never re-paste text that
//                         provably reached the composer.
//   echo FAIL + no ACK  → Esc (clear whatever partial state), re-paste, up to
//                         maxAttempts total. Both signals absent across every
//                         attempt → "failed" (surfaced as delivery_failed).
//
// Turn-ACK is skipped while a turn is active: a mid-turn (steering) message is
// queued by the TUI and only reaches the transcript when the queue drains —
// possibly minutes later — so an ACK timeout there would trigger retries that
// duplicate the message once the queue flushes.
//
// All writes stay serialized through one promise chain — a PTY is a single
// byte stream with no message boundaries, so a delivery cycle must complete
// before the next one starts.

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

// Legacy fixed delay, used only when the echo never appears. Same value and
// rationale as the old PtyWriteQueue: empirically the minimum gap after which
// Claude's bracketed-paste mode reliably accepts a CR.
export const FALLBACK_CR_DELAY_MS = 300;
// Short settle after a confirmed echo so Ink commits the render before the CR.
const POST_ECHO_SETTLE_MS = 50;
// Settle after the CR before the next queued delivery starts.
const POST_CR_SETTLE_MS = 50;
// Settle after Esc before re-pasting on the recovery path.
const ESC_SETTLE_MS = 150;

const ACK_TIMEOUT_MS = 5000;
const RETRY_ACK_TIMEOUT_MS = 3000;
const ECHO_TIMEOUT_CEILING_MS = 5000;
const MAX_ATTEMPTS = 3;

// Echo needle sizing: long enough to be unambiguous, short enough to survive
// composer wrapping after normalization. Texts shorter than the minimum can't
// be echo-verified (and are too risky to re-paste — see ladder above).
const NEEDLE_LEN = 24;
const MIN_NEEDLE_LEN = 4;
// Large pastes are collapsed by the composer into "[Pasted text #N +M lines]",
// so the literal text never echoes — accept the placeholder instead.
const PASTE_PLACEHOLDER = "[Pastedtext";

// Raw PTY output kept for echo matching. Normalization runs over the whole
// buffer each feed (cheap at this size) so escape sequences split across chunk
// boundaries can't corrupt the match.
const ECHO_BUF_CAP = 8192;
// Ack texts kept so an ACK arriving between two wait windows isn't lost.
const ACK_RING_CAP = 4;
export const ACK_MATCH_PREFIX = 512;

const ANSI_RE = new RegExp(
  [
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)?", // OSC
    "\\x1b\\[[0-9;:?<=>]*[ -/]*[@-~]",            // CSI
    "\\x1b[@-Z\\\\-_]",                            // two-char escapes
  ].join("|"),
  "g",
);
// Box-drawing range covers the composer borders (╭ ─ │ ╰ …) that interleave
// with wrapped text; whitespace removal covers the wrap itself.
const STRIP_RE = /[\s─-╿]/g;

/** Normalize terminal output / message text for echo+ACK matching. */
export function normalizeForMatch(s: string): string {
  return s.replace(ANSI_RE, "").replace(STRIP_RE, "");
}

export type DeliveryOutcome =
  | "delivered"   // turn-ACK confirmed
  | "sent"        // ACK not applicable (mid-turn steer / no tail yet); echo or fallback path completed
  | "unverified"  // echo OK but no ACK after re-CR — almost certainly delivered
  | "failed";     // no echo AND no ACK after all attempts — input is lost

export interface DeliveryResult {
  outcome: DeliveryOutcome;
  attempts: number;
}

export interface DeliveryPipelineOptions {
  write(s: string): unknown;
  emit(type: string, payload: unknown): void;
  /** Turn-ACK is only meaningful when the transcript tail is running. */
  canVerifyAck(): boolean;
  /** True while Claude is mid-turn — ACK must be skipped (see header). */
  isTurnActive(): boolean;
  onWriteError?(err: unknown): void;
  fallbackCrDelayMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  /** Test override for the ack/echo wait windows. */
  timeouts?: Partial<{
    ackMs: number;
    retryAckMs: number;
    echoCeilingMs: number;
    postEchoMs: number;
    postCrMs: number;
    escMs: number;
  }>;
}

interface PendingWait {
  resolve(hit: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

export class DeliveryPipeline {
  private chain: Promise<void> = Promise.resolve();
  private readonly opts: DeliveryPipelineOptions;
  private readonly setT: typeof setTimeout;
  private readonly clearT: typeof clearTimeout;
  private readonly crDelayMs: number;

  private echoBuf = "";
  private pendingEcho: (PendingWait & { needle: string }) | null = null;
  private pendingAck: (PendingWait & { sentNorm: string }) | null = null;
  private ackRing: Array<{ norm: string; ts: number }> = [];
  private inFlight = 0;

  constructor(opts: DeliveryPipelineOptions) {
    this.opts = opts;
    this.setT = opts.setTimer ?? setTimeout;
    this.clearT = opts.clearTimer ?? clearTimeout;
    this.crDelayMs = opts.fallbackCrDelayMs ?? FALLBACK_CR_DELAY_MS;
  }

  /** PTY output → echo matcher. Cheap no-op unless an echo wait is pending. */
  feedOutput(chunk: string): void {
    if (!this.pendingEcho) return;
    this.echoBuf = (this.echoBuf + chunk).slice(-ECHO_BUF_CAP);
    const norm = normalizeForMatch(this.echoBuf);
    if (norm.includes(this.pendingEcho.needle) || norm.includes(PASTE_PLACEHOLDER)) {
      const p = this.pendingEcho;
      this.pendingEcho = null;
      this.clearT(p.timer);
      p.resolve(true);
    }
  }

  /** Transcript user message observed by the JSONL tail → turn-ACK matcher. */
  notifyUserText(text: string, ts: number): void {
    const norm = normalizeForMatch(text).slice(0, ACK_MATCH_PREFIX);
    if (norm.length === 0) return;
    this.ackRing.push({ norm, ts });
    if (this.ackRing.length > ACK_RING_CAP) this.ackRing.shift();
    if (this.pendingAck && ackMatches(this.pendingAck.sentNorm, norm)) {
      const p = this.pendingAck;
      this.pendingAck = null;
      this.clearT(p.timer);
      p.resolve(true);
    }
  }

  /** True while any delivery is queued or in flight. */
  get busy(): boolean {
    return this.inFlight > 0;
  }

  /** Serialized verified delivery. The returned promise never rejects. */
  enqueue(text: string): Promise<DeliveryResult> {
    this.inFlight += 1;
    const run = (): Promise<DeliveryResult> =>
      this.deliver(text).catch((err): DeliveryResult => {
        this.opts.onWriteError?.(err);
        return { outcome: "failed", attempts: 0 };
      });
    const result = this.chain.then(run, run);
    this.chain = result.then(() => { this.inFlight -= 1; });
    return result;
  }

  private async deliver(text: string): Promise<DeliveryResult> {
    const t = this.opts.timeouts ?? {};
    const startTs = Date.now();
    const needle = buildNeedle(text);
    const sentNorm = normalizeForMatch(text).slice(0, ACK_MATCH_PREFIX);
    const preview = text.slice(0, 120);
    // Captured once: a turn that starts (or ends) mid-delivery must not flip
    // ACK semantics for an already-launched cycle.
    const ackEligible = this.opts.canVerifyAck() && !this.opts.isTurnActive();

    let attempts = 0;
    let echoOk = false;

    const attemptOnce = async (ackMs: number): Promise<boolean> => {
      attempts += 1;
      this.paste(text);
      echoOk = needle ? await this.waitEcho(needle, echoTimeoutMs(text.length, this.crDelayMs, t.echoCeilingMs)) : false;
      if (needle && !echoOk) this.opts.emit("lifecycle", { phase: "echo_timeout", text: preview, attempt: attempts });
      await this.sleep(echoOk ? (t.postEchoMs ?? POST_ECHO_SETTLE_MS) : this.crDelayMs);
      this.opts.write("\r");
      if (!ackEligible) return false;
      return this.waitAck(sentNorm, startTs, ackMs);
    };

    let acked = await attemptOnce(t.ackMs ?? ACK_TIMEOUT_MS);

    if (!ackEligible) {
      await this.sleep(t.postCrMs ?? POST_CR_SETTLE_MS);
      return { outcome: "sent", attempts };
    }
    if (acked) {
      this.opts.emit("lifecycle", { phase: "prompt_delivered", attempts });
      return { outcome: "delivered", attempts };
    }

    if (echoOk) {
      // Text provably reached the composer — the only plausible loss is a
      // swallowed CR. Re-submit once; never re-paste (duplicate risk).
      this.opts.emit("lifecycle", { phase: "delivery_retry", mode: "cr", text: preview });
      this.opts.write("\r");
      acked = await this.waitAck(sentNorm, startTs, t.retryAckMs ?? RETRY_ACK_TIMEOUT_MS);
      if (acked) {
        this.opts.emit("lifecycle", { phase: "prompt_delivered", attempts });
        return { outcome: "delivered", attempts };
      }
      this.opts.emit("lifecycle", { phase: "delivery_unverified", text: preview, attempts });
      return { outcome: "unverified", attempts };
    }

    if (!needle) {
      // Too short to echo-verify; with no evidence either way, re-pasting
      // risks a duplicate — resolve unverified after the single attempt.
      this.opts.emit("lifecycle", { phase: "delivery_unverified", text: preview, attempts });
      return { outcome: "unverified", attempts };
    }

    while (attempts < MAX_ATTEMPTS) {
      this.opts.emit("lifecycle", { phase: "delivery_retry", mode: "paste", text: preview, attempt: attempts + 1 });
      this.opts.write("\x1b");
      await this.sleep(t.escMs ?? ESC_SETTLE_MS);
      acked = await attemptOnce(t.ackMs ?? ACK_TIMEOUT_MS);
      if (acked) {
        this.opts.emit("lifecycle", { phase: "prompt_delivered", attempts });
        return { outcome: "delivered", attempts };
      }
      if (echoOk) {
        // The re-paste landed but the ACK didn't — same rule as above: stop
        // before anything that could double-deliver.
        this.opts.emit("lifecycle", { phase: "delivery_unverified", text: preview, attempts });
        return { outcome: "unverified", attempts };
      }
    }

    this.opts.emit("lifecycle", { phase: "delivery_failed", text: preview, attempts });
    return { outcome: "failed", attempts };
  }

  private paste(text: string): void {
    this.echoBuf = "";
    this.opts.write(PASTE_START + text + PASTE_END);
  }

  private waitEcho(needle: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = this.setT(() => {
        this.pendingEcho = null;
        resolve(false);
      }, timeoutMs);
      this.pendingEcho = { needle, resolve, timer };
    });
  }

  private waitAck(sentNorm: string, sinceTs: number, timeoutMs: number): Promise<boolean> {
    // An ACK that arrived between wait windows is already in the ring.
    for (const e of this.ackRing) {
      if (e.ts >= sinceTs && ackMatches(sentNorm, e.norm)) return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = this.setT(() => {
        this.pendingAck = null;
        resolve(false);
      }, timeoutMs);
      this.pendingAck = { sentNorm, resolve, timer };
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => { this.setT(resolve, ms); });
  }
}

function buildNeedle(text: string): string | null {
  const n = normalizeForMatch(text);
  if (n.length < MIN_NEEDLE_LEN) return null;
  return n.slice(-NEEDLE_LEN);
}

// Paste processing time scales with size (large prompts repaint slowly), so the
// echo window does too — floor at the legacy CR delay, capped.
function echoTimeoutMs(textLen: number, floorMs: number, ceilingMs?: number): number {
  const ceiling = ceilingMs ?? ECHO_TIMEOUT_CEILING_MS;
  return Math.min(Math.max(floorMs, Math.ceil(textLen / 8) + floorMs), ceiling);
}

// Containment both ways: very long sends are prefix-truncated on both sides
// (equal prefixes). Slash commands reach the transcript split across
// <command-name>/<command-args> XML tags, so when the raw form misses, retry
// with the observed side's tags removed. Exported: the message registry uses
// the same tolerance to pair a transcript user entry with its pending record.
export function ackMatches(sentNorm: string, observedNorm: string): boolean {
  if (sentNorm.length === 0) return false;
  if (observedNorm.includes(sentNorm) || sentNorm.includes(observedNorm)) return true;
  const stripped = observedNorm.replace(/<[^>]*>/g, "");
  return stripped.length > 0 && (stripped.includes(sentNorm) || sentNorm.includes(stripped));
}
