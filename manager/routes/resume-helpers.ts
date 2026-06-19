// Shared resume plumbing for the message-bearing routes (workers +
// orchestrators): rebuild the spec from the row, revive via ResumeWorker, and
// wait for the new ingest server before any dispatch proceeds.

import { existsSync } from "node:fs";
import type { Container } from "../container.ts";
import type { WorkerRow } from "../../contracts/src/worker.ts";
import { resumeWorker } from "../../core/src/use-cases/ResumeWorker.ts";
import { UnreachableError } from "../../core/src/errors/index.ts";
import { buildRespawnSpec } from "../shared/respawn-spec.ts";
import { resolveWorkerTypeByName } from "../../core/src/domain/worker-type-resolution.ts";
import { isWorkerLive } from "./worker-liveness.ts";

export function resumeWorkerVia(c: Container, row: WorkerRow): Promise<{ id: string; port: number }> {
  const spec = buildRespawnSpec(row, {
    modeResolver: c.modeResolver,
    resolveWorkerType: (name) => {
      const t = resolveWorkerTypeByName(name, c.listWorkerTypeRecords(row.worktree_dir ?? row.cwd ?? null));
      return t ? { body: t.body, persistent: t.persistent } : null;
    },
  });
  const kind = row.backend_kind ?? "claude-cli";
  return resumeWorker(
    {
      workers: c.workers, events: c.events, bus: c.bus, clock: c.clock, log: c.log,
      backend: c.backends.has(kind) ? c.backends.get(kind) : c.claudeCliBackend,
      onAgentEvent: c.onAgentEvent,
      isLive: (id) => isWorkerLive(c, id),
      pathExists: existsSync,
    },
    { workerId: row.id, spec },
  );
}

// The resumed node process takes a beat to bind its ingest server;
// HttpWorkerClient has no retry and swallows ECONNREFUSED, so poll first.
async function waitForWorkerHttp(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new UnreachableError("worker", new Error("ingest server did not come up after resume"));
}

// Transparent resume: a message to a dead-but-resumable worker revives it
// (same worker id, claude --resume) before the dispatch proceeds. The message
// itself is safe — the worker buffers pre-boot input until the composer is
// ready, and a boot-time message suppresses the idle settle.
export async function resumeIfDead(c: Container, row: WorkerRow): Promise<void> {
  if (row.state !== "SUSPENDED" && row.state !== "DONE") return;
  if (!row.session_id || c.supervisor.has(row.id)) return;
  const { port } = await resumeWorkerVia(c, row);
  // In-process backends (claude-sdk) have no HTTP ingest port — they're live in
  // the daemon the moment start() returns; only out-of-process workers need the wait.
  if (port > 0) await waitForWorkerHttp(port);
}
