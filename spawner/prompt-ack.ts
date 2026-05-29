// Watches whether the boot prompt was proven received within a window. If no
// proof-of-receipt arrives, it reports the prompt unacknowledged so the daemon
// can stop showing a false WORKING state. Pure timer + callback: it never
// mutates session state and never re-delivers — the caller decides what to do
// on timeout. Mirrors the createShutdownScheduler factory style in session.ts.

export interface PromptAckOptions {
  ackWindowMs: number;
  now(): number;
  onUnacknowledged(elapsedMs: number): void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export interface PromptAckWatchdog {
  arm(): void;
  acknowledge(): void;
  cancel(): void;
}

export function createPromptAckWatchdog(opts: PromptAckOptions): PromptAckWatchdog {
  const setT = opts.setTimer ?? setTimeout;
  const clearT = opts.clearTimer ?? clearTimeout;

  let armedAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let acked = false;
  let armed = false;

  function clear(): void {
    if (timer) { clearT(timer); timer = null; }
  }

  return {
    arm(): void {
      if (armed) return;
      armed = true;
      acked = false;
      armedAt = opts.now();
      timer = setT(() => {
        if (acked) return;
        opts.onUnacknowledged(opts.now() - armedAt);
      }, opts.ackWindowMs);
    },
    acknowledge(): void {
      if (!armed || acked) return;
      acked = true;
      clear();
    },
    cancel(): void {
      acked = true;
      clear();
    },
  };
}
