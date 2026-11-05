import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { TransferChangeEvent, TransferRecord } from "../../../contracts/src/transfer.ts";
import type { JobRegistry } from "./JobRegistry.ts";
import { terminalJobs } from "./sources/terminal.ts";
import { transferJobs } from "./sources/transfer.ts";

// The jobs registry's bus-borne sources: `!` commands, transfers and removed
// workers. Agent tasks and compaction report to their sources directly
// (container.ts); a feature module adds its own (updates, dreams, sync). Seeds
// what is already running.
export function wireJobSources(deps: {
  bus: Pick<EventBus, "subscribe">;
  jobs: JobRegistry;
  killTerminal(runId: string): boolean;
  transfers(): TransferRecord[];
  cancelTransfer(id: string): void;
  machineName(ref: string): string;
}): () => void {
  const { bus, jobs } = deps;
  const terminal = terminalJobs(jobs, { kill: deps.killTerminal });
  const transfer = transferJobs(jobs, { cancel: deps.cancelTransfer, machineName: deps.machineName });

  for (const t of deps.transfers()) transfer.onTransfer({ transfer: t });

  const offs = [
    bus.subscribe("terminal:start", (m) => terminal.onStart(m.payload as Parameters<typeof terminal.onStart>[0])),
    bus.subscribe("terminal:chunk", (m) => terminal.onChunk(m.payload as { runId: string; data: string })),
    bus.subscribe("terminal:done", (m) => terminal.onDone(m.payload as { runId: string; exitCode: number; note: string | null })),
    bus.subscribe("transfer:change", (m) => transfer.onTransfer(m.payload as TransferChangeEvent)),
    bus.subscribe("worker:removed", (m) => {
      const id = (m.payload as { workerId?: string } | null)?.workerId;
      if (id) jobs.forgetWorker(id);
    }),
  ];
  return () => { for (const off of offs) off(); };
}
