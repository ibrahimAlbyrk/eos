// Free-port allocator. Reserves a port in-memory BEFORE the bind probe so
// two concurrent callers can't both see the same port as free.

import { createConnection } from "node:net";
import type { PortAllocator } from "../../../core/src/ports/ProcessSupervisor.ts";

export interface PortAllocatorOptions {
  host: string;
  start: number;
  end: number;
}

export function createPortAllocator(opts: PortAllocatorOptions): PortAllocator {
  const reserved = new Set<number>();

  return {
    async allocate(): Promise<number> {
      for (let p = opts.start; p <= opts.end; p++) {
        if (reserved.has(p)) continue;
        reserved.add(p);
        const free = await new Promise<boolean>((resolve) => {
          const sock = createConnection({ port: p, host: opts.host, timeout: 50 });
          sock.once("connect", () => { sock.destroy(); resolve(false); });
          sock.once("error", () => resolve(true));
          sock.once("timeout", () => { sock.destroy(); resolve(true); });
        });
        if (free) return p;
        reserved.delete(p);
      }
      throw new Error(`no free port in range ${opts.start}-${opts.end}`);
    },
    release(port: number): void {
      reserved.delete(port);
    },
  };
}
