// Resolves a subagent's inner-tool hook to the parent `Agent` tool_use id.
// Subagent inner tools reach Eos only via HTTP hooks (no transcript rows), so
// attribution needs a deterministic key: the hook's `agent_id` points at
// <projects>/<encodeCwd(cwd)>/<sessionId>/subagents/agent-<agentId>.meta.json,
// whose `.toolUseId` is exactly the parent Agent tool_use id.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { encodeCwd } from "./worktree.ts";

export function resolveParentAgentToolUseId(
  cwd: string,
  sessionId: string,
  agentId: string,
  baseDir?: string,
): string | null {
  try {
    const root = baseDir ?? join(homedir(), ".claude", "projects");
    const path = join(root, encodeCwd(cwd), sessionId, "subagents", `agent-${agentId}.meta.json`);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { toolUseId?: unknown };
    return typeof parsed.toolUseId === "string" ? parsed.toolUseId : null;
  } catch {
    return null;
  }
}
