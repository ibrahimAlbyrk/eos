// ResumeWorker — revives a dead-but-resumable worker (SUSPENDED after a daemon
// restart, or DONE after a normal finish) by relaunching claude with
// `--resume <session_id>` under the SAME worker id. The row is UPDATED
// (reactivate), never re-inserted: events history, parent link, worktree
// columns and cost counters all carry on. The respawn spec is rebuilt from the
// row by the caller (manager/shared/respawn-spec.ts) — config paths are a
// manager concern.

import type { WorkerRepo } from "../ports/WorkerRepo.ts";
import type { EventRepo } from "../ports/EventRepo.ts";
import type { EventBus } from "../ports/EventBus.ts";
import type { Clock } from "../ports/Clock.ts";
import type { Logger } from "../ports/Logger.ts";
import type { AgentBackend } from "../ports/AgentBackend.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import { ConflictError, NotFoundError } from "../errors/index.ts";
import { transitionState } from "./TransitionState.ts";
import type { SpawnWorkerSpec } from "./SpawnWorker.ts";

export interface ResumeWorkerDeps {
  workers: WorkerRepo;
  events: EventRepo;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  backend: AgentBackend;
  isLive(workerId: string): boolean;
  pathExists(path: string): boolean;
  /** Routes a resumed in-process backend's canonical events into the daemon
   *  pipeline (claude-sdk). Unused by out-of-process (claude-cli) resume. */
  onAgentEvent?(workerId: string, event: AgentEvent): void;
}

export interface ResumeWorkerInput {
  workerId: string;
  /** Respawn spec rebuilt from the persisted row (buildRespawnSpec). */
  spec: SpawnWorkerSpec;
}

export async function resumeWorker(
  deps: ResumeWorkerDeps,
  input: ResumeWorkerInput,
): Promise<{ id: string; port: number }> {
  const w = deps.workers.findById(input.workerId);
  if (!w) throw new NotFoundError("worker", input.workerId);
  // Resumability is gated by the recorded session_id below: only claude-cli
  // (--resume) and claude-sdk (options.resume) persist one; the in-process API
  // lanes do not, so they never reach here with a session to resume.
  if (w.state !== "SUSPENDED" && w.state !== "DONE") {
    throw new ConflictError(`worker is not resumable (state ${w.state})`);
  }
  if (!w.session_id) throw new ConflictError("worker has no recorded session to resume");
  if (deps.isLive(w.id)) throw new ConflictError("worker process is still alive");
  const cwd = input.spec.cwd;
  if (!cwd || !deps.pathExists(cwd)) {
    throw new ConflictError("workspace directory no longer exists");
  }

  const model = input.spec.model ?? "opus";
  const effort = input.spec.effort ?? "xhigh";
  // No boot prompt — the resumed session already holds the conversation.
  const spec: SpawnWorkerSpec = { ...input.spec, prompt: "", resumeSessionId: w.session_id };

  transitionState(deps, { workerId: w.id, next: "SPAWNING", reason: "resume" });

  // Same daemon bookkeeping as SpawnWorker's onExit.
  const onExit = (code: number | null): void => {
    const now = deps.clock.now();
    deps.workers.markDone(w.id, now, code);
    deps.events.append(w.id, now, "exit", { code });
    deps.bus.publish("worker:exit", { workerId: w.id, code });
  };

  let session;
  try {
    session = await deps.backend.start(
      {
        workerId: w.id,
        cwd,
        model,
        effort,
        prompt: "",
        systemPromptFile: spec.systemPromptFile ?? null,
        permissionMode: spec.claudePermissionMode ?? null,
        persistent: !!spec.persistent,
        parentId: spec.parentId ?? null,
        isOrchestrator: !!spec.isOrchestrator,
        backendOptions: { spec, resume: w.session_id },
      },
      { onExit, onEvent: deps.onAgentEvent ? (e) => deps.onAgentEvent!(w.id, e) : undefined },
    );
  } catch (e) {
    // The process never started — the row is still exactly as resumable as
    // it was before the attempt.
    transitionState(deps, { workerId: w.id, next: "SUSPENDED", reason: "resume_failed" });
    throw e;
  }

  const port = session.handle.kind === "http" ? session.handle.port : 0;
  const pid = session.handle.kind === "http" ? session.handle.pid : null;
  deps.workers.reactivate(w.id, { pid, port });

  const rowId = deps.events.append(w.id, deps.clock.now(), "spawn", {
    resumed: true,
    sessionId: w.session_id,
    pid,
  });
  deps.bus.publish("worker:spawn", { workerId: w.id, rowId });
  deps.log.info("resumed worker", { workerId: w.id, sessionId: w.session_id, port });

  // In-process backends (claude-sdk) resume with no boot prompt and have no PTY
  // readiness gate to self-report IDLE — without this they'd sit in SPAWNING
  // until the first message drives a turn. The session is live + idle the moment
  // start() returns (empty prompt ⇒ no turn), so settle to IDLE now. Out-of-process
  // (claude-cli) keeps self-reporting IDLE via its readiness gate; leave it.
  if (deps.backend.descriptor?.processModel === "in-process") {
    transitionState(deps, { workerId: w.id, next: "IDLE", reason: "resume_ready" });
  }
  return { id: w.id, port };
}
