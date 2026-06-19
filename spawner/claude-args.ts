// claude CLI argv composition. Two MCP wiring modes:
//   1. explicit --mcp-config (orchestrator path) — caller passes the path
//   2. --with-gateway — we synthesize a temp mcp.json wrapping the bundled
//      gateway/server.ts, plus --permission-prompt-tool
// Plus the optional system-prompt + permission-mode + model.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectsMcpReady, type WorkerOptions } from "./options.ts";
import { disallowedBuiltinToolsFor } from "../contracts/src/tool-scope.ts";

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
  // Orchestrators lose Task (no internal subagents — they dispatch via
  // spawn_worker); workers keep it. --disallowedTools is variadic <tools...>, so
  // the unconditional --model push right below terminates the tool list.
  if (opts.isOrchestrator) args.push("--disallowedTools", ...disallowedBuiltinToolsFor(true));
  args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  // Boot prompt as a positional argument: claude consumes it on TUI mount and
  // auto-submits it itself (verified — multi-line/special chars preserved as a
  // single user message), so it is never pasted into a not-yet-ready composer —
  // the boot-paste wedge this replaces. "--" ends option parsing so a prompt
  // beginning with "-" can't be mistaken for a flag. Must stay LAST.
  //
  // EXCEPTION — an agent with an Eos tool MCP (orchestrator/worker): the argv
  // auto-submit fires on mount BEFORE that server finishes connecting, so the
  // first turn can't see spawn_worker etc. (the MCP-init race). For those the
  // prompt is withheld here and delivered by worker.ts once the server signals
  // ready (the mcp-ready gate), through the verified paste pipeline.
  if (opts.prompt && opts.prompt.trim().length > 0 && !expectsMcpReady(opts)) {
    args.push("--", opts.prompt);
  }
  return { args, syntheticMcpPath };
}
