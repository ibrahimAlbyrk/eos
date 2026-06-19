// Pure assembler for the worker child-process argv. Kept side-effect-free and
// container-independent so it can be unit-tested without the whole DI graph.

import type { SpawnWorkerSpec } from "../../core/src/use-cases/SpawnWorker.ts";

// parseArgs({strict:true}) throws on a detached value that starts with "-"
// (e.g. ["--prompt","- task1"]). The attached "=" form is accepted for any
// value, dash-leading or not, so every value-bearing flag goes through here.
export function flagToken(flag: string, value: string): string {
  return `${flag}=${value}`;
}

export interface BuildWorkerArgsInput {
  id: string;
  port: number;
  model: string;
  spec: SpawnWorkerSpec;
  workerScript: string;
  daemonPort: number;
  worker: {
    heartbeatMs: number;
    heartbeatQuietMs: number;
    shutdownGraceMs: number;
    ptyWriteDelayMs: number;
    hydrateEnvFiles?: boolean;
  };
}

export function buildWorkerArgs(input: BuildWorkerArgsInput): string[] {
  const { id, port, model, spec } = input;
  const args = [
    // Runaway guard, not a baseline reducer — a worker node process measures
    // ~20-40MB; this caps a pathological leak far below host memory. The heavy
    // RAM (the claude binary) lives in a separate process, unaffected.
    "--max-old-space-size=512",
    "--experimental-strip-types",
    "--no-warnings",
    input.workerScript,
    flagToken("--daemon-url", `http://127.0.0.1:${input.daemonPort}`),
    flagToken("--worker-id", id),
    flagToken("--port", String(port)),
    flagToken("--heartbeat-ms", String(input.worker.heartbeatMs)),
    flagToken("--heartbeat-quiet-ms", String(input.worker.heartbeatQuietMs)),
    flagToken("--shutdown-grace-ms", String(input.worker.shutdownGraceMs)),
    flagToken("--pty-write-delay-ms", String(input.worker.ptyWriteDelayMs)),
  ];
  if (spec.prompt && spec.prompt.trim().length > 0) {
    args.push(flagToken("--prompt", spec.prompt));
  }
  if (spec.cwd) args.push(flagToken("--cwd", spec.cwd));
  if (spec.worktreeFrom) args.push(flagToken("--worktree-from", spec.worktreeFrom));
  if (spec.worktreeDir) args.push(flagToken("--worktree-dir", spec.worktreeDir));
  if (spec.workspaceOf) args.push("--worktree-attach");
  if (spec.worktreeFrom && !spec.workspaceOf && input.worker.hydrateEnvFiles) args.push("--hydrate-env");
  if (spec.worktreeFrom && !spec.workspaceOf && spec.carryUncommitted) args.push("--carry-uncommitted");
  if (spec.branch) args.push(flagToken("--branch", spec.branch));
  if (spec.name) args.push(flagToken("--name", spec.name));
  if (spec.parentId) args.push(flagToken("--parent-id", spec.parentId));
  if (spec.withGateway) args.push("--with-gateway");
  if (spec.isOrchestrator) args.push("--orchestrator");
  if (spec.persistent) args.push("--persistent");
  if (spec.systemPromptFile) args.push(flagToken("--system-prompt-file", spec.systemPromptFile));
  if (spec.mcpConfig) args.push(flagToken("--mcp-config", spec.mcpConfig));
  if (spec.mcpStrict !== undefined) args.push(flagToken("--mcp-strict", String(spec.mcpStrict)));
  if (spec.permissionPromptTool) args.push(flagToken("--permission-prompt-tool", spec.permissionPromptTool));
  if (spec.claudePermissionMode) args.push(flagToken("--claude-permission-mode", spec.claudePermissionMode));
  if (spec.resumeSessionId) args.push(flagToken("--resume-session", spec.resumeSessionId));
  args.push(flagToken("--model", model));
  if (spec.effort) args.push(flagToken("--effort", spec.effort));
  return args;
}
