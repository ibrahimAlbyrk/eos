// CLI argument parsing + validated WorkerOptions type. Keeping this in one
// place so the worker entrypoint never touches process.argv directly.

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";

export interface WorkerOptions {
  cwd: string | undefined;
  prompt: string;
  name: string | undefined;
  worktreeFrom: string | undefined;
  // Target dir for the worktree, precomputed daemon-side. Create mode makes
  // the worktree at exactly this path; attach mode joins it (must exist).
  worktreeDir: string | undefined;
  worktreeAttach: boolean;
  branch: string | undefined;
  hydrateEnv: boolean;
  carryUncommitted: boolean;
  withGateway: boolean;
  // Session-immutable orchestrator marker (NOT persistent — that's "no
  // auto-shutdown"). Drives the orchestrator-only --disallowedTools removal.
  isOrchestrator: boolean;
  port: number;
  daemonUrl: string | undefined;
  workerId: string | undefined;
  persistent: boolean;
  systemPromptFile: string | undefined;
  mcpConfig: string | undefined;
  mcpStrict: boolean | undefined;
  permissionPromptTool: string | undefined;
  claudePermissionMode: string | undefined;
  resumeSessionId: string | undefined;
  model: string;
  // No default here: the daemon sends an explicit (capability-checked) effort;
  // absent flag means "let claude pick its own default for the model".
  effort: string | undefined;
  parentId: string | undefined;
  heartbeatMs: number | undefined;
  heartbeatQuietMs: number | undefined;
  shutdownGraceMs: number | undefined;
  ptyWriteDelayMs: number | undefined;
  readinessFallbackMs: number | undefined;
  readinessSettleMs: number | undefined;
}

// True when this worker will have an Eos tool-providing MCP server
// (orchestrator or worker) — the kind that signals readiness on connect. Such
// agents must NOT let claude auto-submit the boot prompt before that server is
// up (it would race spawn_worker etc.), so the prompt is withheld from argv and
// released by worker.ts on the mcp-ready signal. Reads the resolved mcp.json
// (daemon-written --mcp-config); the synthetic path (no --mcp-config) carries a
// worker server only when parentId is set. A plain worker — user MCP servers
// only, no orchestrator/worker key — returns false and keeps the argv path.
export function expectsMcpReady(opts: WorkerOptions): boolean {
  if (!opts.workerId) return false;
  if (opts.mcpConfig) {
    try {
      const cfg = JSON.parse(readFileSync(opts.mcpConfig, "utf8")) as { mcpServers?: Record<string, unknown> };
      const servers = cfg.mcpServers ?? {};
      return !!(servers.orchestrator || servers.worker);
    } catch {
      return false;
    }
  }
  return !!opts.parentId;
}

function parseIntFlag(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function parseWorkerOptions(): WorkerOptions {
  const { values } = parseArgs({
    options: {
      cwd: { type: "string" },
      prompt: { type: "string" },
      name: { type: "string" },
      "worktree-from": { type: "string" },
      "worktree-dir": { type: "string" },
      "worktree-attach": { type: "boolean", default: false },
      branch: { type: "string" },
      "hydrate-env": { type: "boolean", default: false },
      "carry-uncommitted": { type: "boolean", default: false },
      "with-gateway": { type: "boolean", default: false },
      orchestrator: { type: "boolean", default: false },
      port: { type: "string", default: "7421" },
      "daemon-url": { type: "string" },
      "worker-id": { type: "string" },
      persistent: { type: "boolean", default: false },
      "system-prompt-file": { type: "string" },
      "mcp-config": { type: "string" },
      "mcp-strict": { type: "string" },
      "permission-prompt-tool": { type: "string" },
      "claude-permission-mode": { type: "string" },
      "resume-session": { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "parent-id": { type: "string" },
      "heartbeat-ms": { type: "string" },
      "heartbeat-quiet-ms": { type: "string" },
      "shutdown-grace-ms": { type: "string" },
      "pty-write-delay-ms": { type: "string" },
      "readiness-fallback-ms": { type: "string" },
      "readiness-settle-ms": { type: "string" },
    },
    strict: true,
  });

  if (!values.cwd && !values["worktree-from"]) {
    console.error(
      "usage: worker.ts (--cwd <dir> | --worktree-from <repo>) [--prompt <text>] " +
        "[--branch <name>] [--worktree-dir <dir>] [--worktree-attach] [--with-gateway] [--port <n>] [--name <id>]",
    );
    process.exit(1);
  }

  return {
    cwd: values.cwd,
    prompt: values.prompt ?? "",
    name: values.name,
    worktreeFrom: values["worktree-from"],
    worktreeDir: values["worktree-dir"],
    worktreeAttach: !!values["worktree-attach"],
    branch: values.branch,
    hydrateEnv: !!values["hydrate-env"],
    carryUncommitted: !!values["carry-uncommitted"],
    withGateway: !!values["with-gateway"],
    isOrchestrator: !!values.orchestrator,
    port: Number(values.port),
    daemonUrl: values["daemon-url"],
    workerId: values["worker-id"],
    persistent: !!values.persistent,
    systemPromptFile: values["system-prompt-file"],
    mcpConfig: values["mcp-config"],
    mcpStrict: values["mcp-strict"] === undefined ? undefined : values["mcp-strict"] !== "false",
    permissionPromptTool: values["permission-prompt-tool"],
    claudePermissionMode: values["claude-permission-mode"],
    resumeSessionId: values["resume-session"],
    model: values.model ?? "opus",
    effort: values.effort,
    parentId: values["parent-id"],
    heartbeatMs: parseIntFlag(values["heartbeat-ms"]),
    heartbeatQuietMs: parseIntFlag(values["heartbeat-quiet-ms"]),
    shutdownGraceMs: parseIntFlag(values["shutdown-grace-ms"]),
    ptyWriteDelayMs: parseIntFlag(values["pty-write-delay-ms"]),
    readinessFallbackMs: parseIntFlag(values["readiness-fallback-ms"]),
    readinessSettleMs: parseIntFlag(values["readiness-settle-ms"]),
  };
}
