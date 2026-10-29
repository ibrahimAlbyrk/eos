import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { DreamChangeEvent, DreamStatus } from "../../../contracts/src/dream.ts";
import type { SyncStatusResponse } from "../../../contracts/src/sync.ts";
import type { TransferChangeEvent, TransferRecord } from "../../../contracts/src/transfer.ts";
import type { UpdateState } from "../../../contracts/src/update.ts";
import type { BackgroundJobService } from "../BackgroundJobService.ts";

// The jobs registry's bus-borne sources: `!` commands, transfers, dreams, sync,
// in-app updates and removed workers. Agent tasks, compaction and Workflow progress report to
// the service directly (container.ts). Seeds what is already running.
export function wireJobSources(deps: {
  bus: Pick<EventBus, "subscribe">;
  jobs: BackgroundJobService;
  transfers(): TransferRecord[];
  dreamStatus(): DreamStatus;
  syncStatus(): SyncStatusResponse;
}): () => void {
  const { bus, jobs } = deps;
  for (const transfer of deps.transfers()) jobs.onTransfer({ transfer });
  const dream = deps.dreamStatus();
  if (dream.running) jobs.onDream({ runId: dream.runId, status: "running" }, dream);
  jobs.onSync(deps.syncStatus());

  const offs = [
    bus.subscribe("terminal:start", (m) => jobs.onTerminalStart(m.payload as Parameters<BackgroundJobService["onTerminalStart"]>[0])),
    bus.subscribe("terminal:chunk", (m) => jobs.onTerminalChunk(m.payload as { runId: string; data: string })),
    bus.subscribe("terminal:done", (m) => jobs.onTerminalDone(m.payload as { runId: string; exitCode: number; note: string | null })),
    bus.subscribe("transfer:change", (m) => jobs.onTransfer(m.payload as TransferChangeEvent)),
    bus.subscribe("dream:change", (m) => jobs.onDream(m.payload as DreamChangeEvent, deps.dreamStatus())),
    bus.subscribe("sync:change", (m) => jobs.onSync(m.payload as SyncStatusResponse)),
    bus.subscribe("update:change", (m) => jobs.onUpdate(m.payload as UpdateState)),
    bus.subscribe("worker:removed", (m) => {
      const id = (m.payload as { workerId?: string } | null)?.workerId;
      if (id) jobs.forgetWorker(id);
    }),
  ];
  return () => { for (const off of offs) off(); };
}
