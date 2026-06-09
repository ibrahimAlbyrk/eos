// claude CLI argv composition. Two MCP wiring modes:
//   1. explicit --mcp-config (orchestrator path) — caller passes the path
//   2. --with-gateway — we synthesize a temp mcp.json wrapping the bundled
//      gateway/server.ts, plus --permission-prompt-tool
// Plus the optional system-prompt + permission-mode + model.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkerOptions } from "./options.ts";

export interface ClaudeArgsResult {
  args: string[];
  /** Path to the synthesized mcp.json if `--with-gateway` was used.
   * Cleaned up by settings tmp dir teardown — they share the same dir. */
  syntheticMcpPath: string | null;
}

function buildWorkerMcpEntry(workerEnv: { daemonUrl?: string; workerId?: string }): Record<string, unknown> {
  const repoRoot = process.env.EOS_REPO_ROOT || "";
  return {
    command: "node",
    args: ["--no-warnings", "--experimental-strip-types", join(repoRoot, "manager", "worker-mcp.ts")],
    env: {
      ...(process.env as Record<string, string>),
      EOS_DAEMON_URL: workerEnv.daemonUrl ?? "",
      EOS_WORKER_ID: workerEnv.workerId ?? "",
    },
    alwaysLoad: true,
  };
}

export function buildClaudeArgs(
  opts: WorkerOptions,
  settingsTmpDir: string,
  settingsPath: string,
  workerEnv: { daemonUrl?: string; workerId?: string },
): ClaudeArgsResult {
  const args: string[] = ["--settings", settingsPath];
  let syntheticMcpPath: string | null = null;

  if (opts.mcpConfig) {
    // Strict by default (back-compat); the daemon passes --mcp-strict=false for
    // the additive path, where claude must still discover its own MCP servers.
    if (opts.mcpStrict !== false) args.push("--strict-mcp-config");
    args.push("--mcp-config", opts.mcpConfig);
    if (opts.permissionPromptTool) {
      args.push("--permission-prompt-tool", opts.permissionPromptTool);
    }
  } else if (opts.withGateway || opts.parentId) {
    syntheticMcpPath = join(settingsTmpDir, "mcp.json");
    const servers: Record<string, unknown> = {};

    if (opts.withGateway) {
      const bunBin = process.env.EOS_BUN_BIN || "bun";
      const gatewayScript = process.env.EOS_GATEWAY_SCRIPT
        || join(process.env.EOS_REPO_ROOT || "", "gateway", "server.ts");
      servers.gateway = {
        command: bunBin,
        args: ["run", gatewayScript],
        env: workerEnv.daemonUrl && workerEnv.workerId
          ? { ...(process.env as Record<string, string>), EOS_DAEMON_URL: workerEnv.daemonUrl, EOS_WORKER_ID: workerEnv.workerId }
          : { ...(process.env as Record<string, string>) },
      };
    }

    if (opts.parentId) {
      servers.worker = buildWorkerMcpEntry(workerEnv);
    }

    writeFileSync(syntheticMcpPath, JSON.stringify({ mcpServers: servers }));

    args.push("--strict-mcp-config", "--mcp-config", syntheticMcpPath);
    if (opts.withGateway) {
      args.push("--permission-prompt-tool", "mcp__gateway__decide");
    }
  }
  if (opts.systemPromptFile) args.push("--append-system-prompt-file", opts.systemPromptFile);
  if (opts.claudePermissionMode) args.push("--permission-mode", opts.claudePermissionMode);
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
  args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  return { args, syntheticMcpPath };
}
