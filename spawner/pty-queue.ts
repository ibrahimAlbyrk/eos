// Serializes PTY writes. Two concurrent /message POSTs without this race
// produced interleaved bytes like "msg1msg2\r" — PTY is a single byte
// stream with no logical message boundaries, so every text+CR pair must
// complete before the next pair starts.

// Default delay between writing the user's text and writing the carriage
// return. Claude's interactive TUI uses bracketed-paste mode, which
// swallows a CR if it arrives in the same write as text. The 300ms gap is
// empirical: anything noticeably less drops the CR; anything more adds
// latency without benefit. Configurable via the constructor option.
export const PTY_CR_DELAY_MS = 300;
// Settle window after the CR before the next queued write starts, so
// Claude has time to commit the previous input event before we hand it
// new bytes.
export const PTY_POST_CR_SETTLE_MS = 50;

export interface PtyWriter {
  write(s: string): unknown;
}

export class PtyWriteQueue {
  private chain: Promise<void> = Promise.resolve();
  private readonly writer: PtyWriter;
  private readonly onWriteError?: (err: unknown) => void;
  private readonly crDelayMs: number;

  constructor(
    writer: PtyWriter,
    onWriteError?: (err: unknown) => void,
    crDelayMs: number = PTY_CR_DELAY_MS,
  ) {
    this.writer = writer;
    this.onWriteError = onWriteError;
    this.crDelayMs = crDelayMs;
  }

  enqueue(text: string): Promise<void> {
    const task = (): Promise<void> => new Promise<void>((resolve) => {
      this.writer.write(text);
      setTimeout(() => {
        this.writer.write("\r");
        setTimeout(resolve, PTY_POST_CR_SETTLE_MS);
      }, this.crDelayMs);
    });
    const next = this.chain.then(task, task);
    // Swallow rejections so one bad write doesn't poison the chain, and so
    // the promise returned to callers can never surface as an
    // unhandledRejection that self-terminates the worker.
    const guarded = next.catch((err) => { this.onWriteError?.(err); });
    this.chain = guarded;
    return guarded;
  }
}
