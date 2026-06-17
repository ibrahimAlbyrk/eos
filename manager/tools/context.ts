// Session -> ToolContext mappers, shared by the MCP entrypoints and the
// registration golden test so both build identical contexts. The orchestrator
// session carries cwd + isGitRepo (spawn_worker needs them); a worker session
// has neither, so worker tools get inert values (none of them read cwd/isGitRepo).

import type { ToolContext } from "./types.ts";
import type { OrchestratorSession } from "../orchestrator-mcp/SessionContext.ts";
import type { WorkerSession } from "../worker-mcp/SessionContext.ts";

export const orchestratorCtx = (s: OrchestratorSession): ToolContext => ({
  selfId: s.selfId,
  cwd: s.cwd,
  isGitRepo: s.isGitRepo,
  api: s.api,
});

export const workerCtx = (s: WorkerSession): ToolContext => ({
  selfId: s.selfId,
  cwd: "",
  isGitRepo: () => false,
  api: s.api,
});
