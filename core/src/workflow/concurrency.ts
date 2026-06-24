// concurrency.ts — a pure counting semaphore implementing the ConcurrencyGate
// port (§3.9). Eos has no native cap, so the engine owns one: applied at the
// single leaf-step choke point, it bounds any fan-out source (parallel / forEach
// / pipeline / nested) uniformly. `run<T>` wraps acquire/release so the permit is
// returned even when the wrapped work throws (exception-safe). A freed permit is
// handed directly to the next waiter rather than bouncing through the counter, so
// FIFO order is preserved. Pure: promises + a queue, zero Node, no time/random.

import type { ConcurrencyGate } from "../ports/ConcurrencyGate.ts";

export class CountingSemaphore implements ConcurrencyGate {
  private available: number;
  private readonly waiters: Array<() => void>;

  constructor(capacity: number) {
    // A non-positive cap would deadlock every acquire; clamp to a serial gate.
    this.available = capacity > 0 ? Math.floor(capacity) : 1;
    this.waiters = [];
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();          // transfer the permit straight to the next waiter
    else this.available += 1;
  }
}
