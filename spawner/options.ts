// CLI argument parsing + validated WorkerOptions type. Keeping this in one
// place so the worker entrypoint never touches process.argv directly.

import { parseArgs } from "node:util";

export interface WorkerOptions {
  cwd: string | undefined;
  prompt: string;
  name: string | undefined;
  worktreeFrom: string | undefined;
  branch: string | undefined;
  keepWorktree: boolean;
  withGateway: boolean;
  port: number;
  daemonUrl: string | undefined;
  workerId: string | undefined;
  persistent: boolean;
  systemPromptFile: string | undefined;
  mcpConfig: string | undefined;
  permissionPromptTool: string | undefined;
  claudePermissionMode: string | undefined;
  model: string;
  effort: string;
  parentId: string | undefined;
}

export function parseWorkerOptions(): WorkerOptions {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string" },
      prompt: { type: "string" },
      name: { type: "string" },
      "worktree-from": { type: "string" },
      branch: { type: "string" },
      "keep-worktree": { type: "boolean", default: false },
      "with-gateway": { type: "boolean", default: false },
      port: { type: "string", default: "7421" },
      "daemon-url": { type: "string" },
      "worker-id": { type: "string" },
      persistent: { type: "boolean", default: false },
      "system-prompt-file": { type: "string" },
      "mcp-config": { type: "string" },
      "permission-prompt-tool": { type: "string" },
      "claude-permission-mode": { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "parent-id": { type: "string" },
    },
    strict: true,
  });

  if (!values.cwd && !values["worktree-from"]) {
    console.error(
      "usage: worker.ts (--cwd <dir> | --worktree-from <repo>) [--prompt <text>] " +
        "[--branch <name>] [--keep-worktree] [--with-gateway] [--port <n>] [--name <id>]",
    );
    process.exit(1);
  }

  return {
    cwd: values.cwd,
    prompt: values.prompt ?? "",
    name: values.name,
    worktreeFrom: values["worktree-from"],
    branch: values.branch,
    keepWorktree: !!values["keep-worktree"],
    withGateway: !!values["with-gateway"],
    port: Number(values.port),
    daemonUrl: values["daemon-url"],
    workerId: values["worker-id"],
    persistent: !!values.persistent,
    systemPromptFile: values["system-prompt-file"],
    mcpConfig: values["mcp-config"],
    permissionPromptTool: values["permission-prompt-tool"],
    claudePermissionMode: values["claude-permission-mode"],
    model: values.model ?? "opus",
    effort: values.effort ?? "high",
    parentId: values["parent-id"],
  };
}
