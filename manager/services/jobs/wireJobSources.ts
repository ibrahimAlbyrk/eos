import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { DreamChangeEvent, DreamStatus } from "../../../contracts/src/dream.ts";
import type { SyncStatusResponse } from "../../../contracts/src/sync.ts";
import type { TransferChangeEvent, TransferRecord } from "../../../contracts/src/transfer.ts";
import type { JobRegistry } from "./JobRegistry.ts";
import { terminalJobs } from "./sources/terminal.ts";
import { transferJobs } from "./sources/transfer.ts";
import { dreamJobs } from "./sources/dream.ts";
import { syncJobs } from "./sources/sync.ts";

// The jobs registry's bus-borne sources: `!` commands, transfers, dreams, sync
// and removed workers. Agent tasks and compaction report to their sources
// directly (container.ts); a feature module adds its own (updates). Seeds what is
// already running.
export function wireJobSources(deps: {
  bus: Pick<EventBus, "subscribe">;
  jobs: JobRegistry;
  killTerminal(runId: string): boolean;
  transfers(): TransferRecord[];
  cancelTransfer(id: string): void;
  machineName(ref: string): string;
  dreamStatus(): DreamStatus;
  stopDream(): boolean;
  syncStatus(): SyncStatusResponse;
}): () => void {
  const { bus, jobs } = deps;
  const terminal = terminalJobs(jobs, { kill: deps.killTerminal });
  const transfer = transferJobs(jobs, { cancel: deps.cancelTransfer, machineName: deps.machineName });
  const dream = dreamJobs(jobs, { stop: deps.stopDream });
  const sync = syncJobs(jobs);

  for (const t of deps.transfers()) transfer.onTransfer({ transfer: t });
  const dreamNow = deps.dreamStatus();
  if (dreamNow.running) dream.onDream({ runId: dreamNow.runId, status: "running" }, dreamNow);
  sync.onSync(deps.syncStatus());

  const offs = [
    bus.subscribe("terminal:start", (m) => terminal.onStart(m.payload as Parameters<typeof terminal.onStart>[0])),
    bus.subscribe("terminal:chunk", (m) => terminal.onChunk(m.payload as { runId: string; data: string })),
    bus.subscribe("terminal:done", (m) => terminal.onDone(m.payload as { runId: string; exitCode: number; note: string | null })),
    bus.subscribe("transfer:change", (m) => transfer.onTransfer(m.payload as TransferChangeEvent)),
    bus.subscribe("dream:change", (m) => dream.onDream(m.payload as DreamChangeEvent, deps.dreamStatus())),
    bus.subscribe("sync:change", (m) => sync.onSync(m.payload as SyncStatusResponse)),
    bus.subscribe("worker:removed", (m) => {
      const id = (m.payload as { workerId?: string } | null)?.workerId;
      if (id) jobs.forgetWorker(id);
    }),
  ];
  return () => {
    for (const off of offs) off();
    sync.dispose();
  };
}
