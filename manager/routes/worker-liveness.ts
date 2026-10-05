// Is this worker's session live, across backends? Out-of-process (claude-cli)
// workers are supervised PTY children (the supervisor map); in-process
// (claude/…) workers have no child — their liveness is the backend
// session's own aliveness. Single source for the message / report / peer /
// resume paths so none re-derives it and forgets the in-process branch (the
// old `!port || !supervisor.has` checks dropped every in-process target).

import type { Container } from "../container.ts";
import type { AgentSession } from "../../core/src/ports/AgentBackend.ts";

function inProcessSession(c: Container, id: string): AgentSession | null {
  const kind = c.workers.findById(id)?.backend_kind;
  if (!kind || !c.backends.has(kind) || c.backends.get(kind).descriptor.processModel !== "in-process") return null;
  return c.backends.get(kind).attach(id, { kind: "inproc", ref: id });
}

export function isWorkerLive(c: Container, id: string): boolean {
  if (c.supervisor.has(id)) return true;
  return inProcessSession(c, id)?.isAlive() ?? false;
}

// Background subagents still running in this worker's session (0 on lanes
// that don't track them).
export function liveSubagentCount(c: Container, id: string): number {
  return inProcessSession(c, id)?.liveSubagents?.() ?? 0;
}
