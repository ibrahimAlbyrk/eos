// Dreaming (Settings › Profile, off by default): overnight, Opus reads the
// finished chats and proposes memory changes for the user to keep or dismiss.
// The schedule, its guards and the run live in DreamService; what a dream reads
// (chats, profile, memories) and runs on (the summarizer, the sign-in's usage)
// comes in through deps.

import type { DatabaseSync } from "node:sqlite";

import type { DaemonModule } from "../types.ts";
import type { DreamChangeEvent } from "../../../contracts/src/dream.ts";
import type { DreamSession } from "../../../core/src/domain/dream.ts";
import type { Clock } from "../../../core/src/ports/Clock.ts";
import type { EventBus } from "../../../core/src/ports/EventBus.ts";
import type { Logger } from "../../../core/src/ports/Logger.ts";
import type { WorkerRepo } from "../../../core/src/ports/WorkerRepo.ts";
import { dreamOverChats, type DreamDeps } from "../../../core/src/use-cases/DreamOverChats.ts";
import { SqliteDreamRepo } from "../../../infra/src/persistence/SqliteDreamRepo.ts";
import type { JobRegistry } from "../../services/jobs/JobRegistry.ts";
import { DreamService, type DreamServiceDeps } from "./DreamService.ts";
import { DREAM_SCHEMAS } from "./schemas.ts";
import { dreamJobs } from "./jobs.ts";
import { registerDreamRoutes } from "./routes.ts";

declare module "../../../core/src/ports/EventBus.ts" {
  interface EventBusTopics {
    // A dream started, moved on, or finished (payload DreamChangeEvent) — the
    // Memory view, Settings › Dreaming and the dream log refetch its status.
    "dream:change": true;
  }
}

export interface DreamsModuleDeps {
  readonly db: DatabaseSync;
  // What a dream reads and runs on (see DreamOverChats).
  readonly summarizer: DreamDeps["summarizer"];
  readonly prompts: DreamDeps["prompts"];
  readonly sessions: () => DreamSession[];
  readonly lines: DreamDeps["lines"];
  readonly memories: DreamDeps["memories"];
  readonly profile: DreamDeps["profile"] & { get(): { dreaming: ReturnType<DreamServiceDeps["settings"]> } };
  readonly profileDigest: () => string;
  readonly timeoutMs: () => number;
  // Guards: an Eos Claude sign-in to dream on, and how much of its plan is used (0–1).
  readonly signedIn: DreamServiceDeps["signedIn"];
  readonly usage: DreamServiceDeps["usage"];
  readonly workers: Pick<WorkerRepo, "listAll" | "findById">;
  readonly jobs: JobRegistry;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly log: Logger;
  readonly uiToken: string;
}

export function createDreamsModule(deps: DreamsModuleDeps): DaemonModule {
  const dreamRepo = new SqliteDreamRepo(deps.db);
  const dreams = new DreamService({
    run: ({ trigger, onProgress, shouldStop }) => dreamOverChats({
      repo: dreamRepo,
      summarizer: deps.summarizer,
      schemas: DREAM_SCHEMAS,
      prompts: deps.prompts,
      sessions: deps.sessions,
      lines: deps.lines,
      memories: deps.memories,
      profile: deps.profile,
      profileDigest: deps.profileDigest,
      clock: deps.clock,
      newId: deps.newId,
      timeoutMs: deps.timeoutMs(),
      shouldStop,
      onProgress,
    }, { trigger }),
    repo: dreamRepo,
    settings: () => deps.profile.get().dreaming,
    clock: deps.clock,
    bus: deps.bus,
    signedIn: deps.signedIn,
    usage: deps.usage,
    anyWorking: () => deps.workers.listAll().some((w) => w.state === "WORKING"),
    newId: deps.newId,
    notify: (run) => deps.bus.publish("notification:fire", {
      title: `Eos dreamt · ${run.proposed} to review`,
      body: run.narrative ?? "Review what it noticed while you were away.",
      workerId: "",
      route: "memory",
      ts: deps.clock.now(),
    }),
    log: deps.log,
  });
  return {
    id: "dreams",
    registerRoutes: (router) => registerDreamRoutes(router, { dreams, dreamRepo, uiToken: deps.uiToken }),
    start: () => {
      // A top-level chat starting work means the user is here — a scheduled
      // dream stops after its current chat, and "away" restarts its clock.
      deps.bus.subscribe("worker:change", (msg) => {
        const p = msg.payload as { workerId?: string; state?: string };
        if (p?.state === "WORKING" && p.workerId && !deps.workers.findById(p.workerId)?.parent_id) dreams.noteUserActivity();
      });
      // A dream in progress shows in the Jobs list.
      const asJob = dreamJobs(deps.jobs, { stop: () => dreams.requestStop() });
      const now = dreams.status();
      if (now.running) asJob.onDream({ runId: now.runId, status: "running" }, now);
      deps.bus.subscribe("dream:change", (m) => asJob.onDream(m.payload as DreamChangeEvent, dreams.status()));
      dreams.start();
    },
    stop: () => dreams.stop(),
  };
}
