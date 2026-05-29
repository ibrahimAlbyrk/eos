// Detects when claude's interactive TUI is ready to accept pasted input, so
// the boot prompt is never written into a composer that has not mounted yet —
// which silently swallows the carriage return and loses the prompt entirely.
//
// Signal: the composer box-border glyph '╭' (U+256D). Empirically (claude
// v2.1.156, 155 worker + 252 orchestrator logs) the only ready-marker present
// across every permission mode (acceptEdits / plan / gateway / default /
// bypassPermissions); it is a single codepoint emitted in its own SGR run, so
// it survives the chunk/SGR splitting that defeats a multi-word footer string.
//
// After the first sighting we wait for a quiescence window (no further PTY
// bytes for settleMs) so an in-flight repaint finishes before we write. If the
// marker never arrives we fall back to a bounded timeout, so the gate is never
// slower than the old fixed boot delay.

export interface ReadinessGateOptions {
  marker: string;
  fallbackMs: number;
  settleMs: number;
  onReady(reason: "marker" | "fallback"): void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export interface ReadinessGate {
  feed(chunk: string): void;
  cancel(): void;
  readonly settled: boolean;
}

export function createReadinessGate(opts: ReadinessGateOptions): ReadinessGate {
  const setT = opts.setTimer ?? setTimeout;
  const clearT = opts.clearTimer ?? clearTimeout;
  const tailLen = Math.max(opts.marker.length, 8);

  let tail = "";
  let markerSeen = false;
  let settled = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = setT(
    () => settle("fallback"),
    opts.fallbackMs,
  );
  let settleTimer: ReturnType<typeof setTimeout> | null = null;

  function settle(reason: "marker" | "fallback"): void {
    if (settled) return;
    settled = true;
    if (fallbackTimer) { clearT(fallbackTimer); fallbackTimer = null; }
    if (settleTimer) { clearT(settleTimer); settleTimer = null; }
    opts.onReady(reason);
  }

  return {
    get settled(): boolean { return settled; },
    feed(chunk: string): void {
      if (settled) return;
      // Rolling tail keeps the previous chunk's suffix so a marker straddling a
      // chunk boundary is still matched.
      const hay = tail + chunk;
      tail = hay.slice(-tailLen);
      if (!markerSeen && hay.includes(opts.marker)) markerSeen = true;
      if (markerSeen) {
        if (settleTimer) clearT(settleTimer);
        settleTimer = setT(() => settle("marker"), opts.settleMs);
      }
    },
    cancel(): void {
      if (fallbackTimer) { clearT(fallbackTimer); fallbackTimer = null; }
      if (settleTimer) { clearT(settleTimer); settleTimer = null; }
      settled = true;
    },
  };
}
