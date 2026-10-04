import type { IncomingMessage } from "node:http";
import type { Container } from "../container.ts";
import { sessionProjectOf } from "../../core/src/services/session-root.ts";

export interface AgentCaller {
  readonly id: string;
  readonly name: string;
  // The session's project folder (worktrees resolve to their source repo).
  readonly project: string | null;
  readonly kind: string | null;
}

// The agent behind a request — its MCP tools send x-eos-agent-id. Declared, not
// authenticated: it attributes and scopes, it never authorizes a user-only action
// (those need the ui-token). null = not a known agent.
export function agentCallerOf(c: Container, req: IncomingMessage): AgentCaller | null {
  const raw = req.headers["x-eos-agent-id"];
  const id = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  const worker = id ? c.workers.findById(id) : null;
  if (!id || !worker) return null;
  return {
    id,
    name: worker.name ?? id,
    project: sessionProjectOf(c.workers, id),
    kind: worker.backend_kind ?? null,
  };
}
