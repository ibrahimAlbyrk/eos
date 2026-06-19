// Shared resume plumbing for the message-bearing routes (workers +
// orchestrators): rebuild the spec from the row, revive via ResumeWorker, and
// wait for the new ingest server before any dispatch proceeds.

import { existsSync } from "node:fs";
import type { Container } from "../container.ts";
import type { WorkerRow } from "../../contracts/src/worker.ts";
import { resumeWorker } from "../../core/src/use-cases/ResumeWorker.ts";
import { ConflictError, NotFoundError, UnreachableError } from "../../core/src/errors/index.ts";
import { buildRespawnSpec } from "../shared/respawn-spec.ts";
import { resolveWorkerDefinitionByName } from "../../core/src/domain/worker-definition-resolution.ts";
import { planBackendSwitch } from "../../core/src/domain/backend-switch.ts";
import { isWorkerLive } from "./worker-liveness.ts";

export function resumeWorkerVia(c: Container, row: WorkerRow): Promise<{ id: string; port: number }> {
  const spec = buildRespawnSpec(row, {
    modeResolver: c.modeResolver,
    resolveWorkerDefinition: (name) => {
      const t = resolveWorkerDefinitionByName(name, c.listWorkerDefinitionRecords(row.worktree_dir ?? row.cwd ?? null));
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

// Stop a worker's live session WITHOUT deleting its row (unlike KillWorker):
// CLI → escalate the supervised PTY child; in-process → stop the backend session.
// Mirrors KillWorker's branch but keeps the identity for a respawn.
function stopWorkerSession(c: Container, id: string): void {
  if (c.supervisor.has(id)) { c.supervisor.escalateKill(id); return; }
  const kind = c.workers.findById(id)?.backend_kind;
  if (kind && c.backends.has(kind)) c.backends.get(kind).attach(id, { kind: "inproc", ref: id }).stop();
}

async function waitUntilDead(c: Container, id: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isWorkerLive(c, id)) return; // process exit ran onExit → markDone (state DONE = resumable)
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new UnreachableError("worker", new Error("worker did not exit for backend switch"));
}

// Switch a running worker's provider: stop the old session, repoint backend_kind,
// and resume under the new backend reusing the persisted session id (the resumed
// claude binary reloads the shared transcript). Only valid between backends that
// share a conversation store — enforced by planBackendSwitch.
export async function switchWorkerBackend(
  c: Container, id: string, targetKind: string,
): Promise<{ id: string; kind: string; port: number }> {
  const row = c.workers.findById(id);
  if (!row) throw new NotFoundError("worker", id);

  const sourceKind = row.backend_kind ?? "claude-cli";
  const source = c.backends.has(sourceKind) ? c.backends.get(sourceKind) : c.claudeCliBackend;
  if (!c.backends.has(targetKind)) throw new ConflictError(`unknown backend "${targetKind}"`);
  const target = c.backends.get(targetKind);

  const plan = planBackendSwitch({
    state: row.state,
    sessionId: row.session_id ?? null,
    isLive: isWorkerLive(c, id),
    source: source.descriptor,
    target: target.descriptor,
  });
  if (!plan.ok) throw new ConflictError(`cannot switch backend: ${plan.reason}`);

  // Breadcrumb so the chat explains the exit+respawn that follows.
  c.events.append(id, c.clock.now(), "lifecycle", { kind: "backend_switch", from: sourceKind, to: targetKind });

  // Stop the OLD session BEFORE repointing backend_kind — the live session is
  // registered in the SOURCE backend; stopping after the swap would leak it.
  if (plan.needsStop) {
    stopWorkerSession(c, id);
    await waitUntilDead(c, id);
  }

  c.workers.updateBackendKind(id, targetKind);

  const fresh = c.workers.findById(id);
  if (!fresh) throw new NotFoundError("worker", id);
  const { port } = await resumeWorkerVia(c, fresh);
  if (port > 0) await waitForWorkerHttp(port);
  return { id, kind: targetKind, port };
}
