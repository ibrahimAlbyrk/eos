// Context compaction — a tool-less summarizer on the agent's own model condenses
// the transcript; the session restarts seeded with the summary. Triggered on the
// IDLE edge at the configured threshold (ahead of the loop and the nudges), or by
// /compact. While it runs, messages to the worker queue.

import type { DaemonModule } from "../types.ts";
import type { DaemonConfig } from "../../shared/config.ts";
import type { JobRegistry } from "../../services/jobs/JobRegistry.ts";
import { compactContext, compactionSession, type CompactContextDeps } from "../../../core/src/use-cases/CompactContext.ts";
import { createCompactCommand } from "../../../core/src/domain/commands/compact.ts";
import { CompactionService } from "./CompactionService.ts";
import { compactionJobs } from "./jobs.ts";

export interface CompactionModuleDeps extends Omit<CompactContextDeps, "timeoutMs"> {
  readonly config: () => DaemonConfig["compaction"];
  // Occupancy ratio past which an auto run stops waiting for subagents.
  readonly deferCap: () => number;
  readonly jobs: JobRegistry;
}

// Ahead of the goal loop, the report nudge and the context watcher: a worker at
// or over the threshold is compacted before anything hands it more work.
const IDLE_ORDER = 10;

export function createCompactionModule(deps: CompactionModuleDeps): DaemonModule {
  const asJob = compactionJobs(deps.jobs);
  const compaction = new CompactionService({
    workers: deps.workers,
    config: deps.config,
    contextWindowFor: deps.contextWindowFor,
    canCompact: (id, kind) => compactionSession(deps, id, kind) !== null,
    liveSubagents: (id, kind) => compactionSession(deps, id, kind)?.liveSubagents?.() ?? 0,
    deferCap: deps.deferCap,
    onRunChange: (workerId, running) => asJob.onCompaction(workerId, running),
    run: (input) => compactContext({ ...deps, timeoutMs: () => deps.config().timeoutMs }, input),
    log: deps.log,
  });
  return {
    id: "compaction",
    // It holds the worker in WORKING and settles to IDLE, which runs the hooks again.
    idleHooks: [{ id: "compaction", order: IDLE_ORDER, run: (id) => compaction.checkOnIdle(id) }],
    slashCommands: [createCompactCommand((id, instructions) => compaction.start(id, instructions))],
    holdsWorker: (id) => compaction.isCompacting(id),
  };
}
