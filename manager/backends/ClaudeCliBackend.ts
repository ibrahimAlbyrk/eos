// ClaudeCliBackend — the first AgentBackend adapter. It wraps the existing
// claude-cli execution machinery (ProcessSupervisor + PortAllocator +
// WorkerClient + the container's buildArgs/buildEnv) behind the backend-agnostic
// port, with NO behavior change. `start` spawns a PTY child; `attach`
// reconstructs a stateless session from a persisted handle (the daemon re-derives
// operations from the DB row's port on demand, exactly as it did before).

import type {
  AgentBackend,
  AgentSession,
  AgentLaunchSpec,
  AgentStartCallbacks,
  AgentCapabilities,
  WorkerHandle,
} from "../../core/src/ports/AgentBackend.ts";
import type { ProcessSupervisor } from "../../core/src/ports/ProcessSupervisor.ts";
import type { PortAllocator } from "../../core/src/ports/PortAllocator.ts";
import type { WorkerClient } from "../../core/src/ports/WorkerClient.ts";
import type { SpawnWorkerSpec } from "../../core/src/use-cases/SpawnWorker.ts";

// The claude CLI supports interrupt (ESC), keystrokes, and the /model + /permissions
// slash commands at runtime.
const CLI_CAPS: AgentCapabilities = {
  interrupt: true,
  keystroke: true,
  runtimeModelSwitch: true,
  runtimePermissionSwitch: true,
  // The worker emits user_message/orchestrator_message itself when the text
  // lands in the transcript JSONL — transcript-anchored ordering.
  reportsMessageEvents: true,
};

export interface ClaudeCliBackendDeps {
  supervisor: ProcessSupervisor;
  ports: PortAllocator;
  client: WorkerClient;
  buildArgs(input: { id: string; port: number; spec: SpawnWorkerSpec; model: string }): string[];
  buildEnv(input: { id: string; spec: SpawnWorkerSpec }): Record<string, string>;
  logFileFor(id: string): string;
  /** DPI: assemble the worker's appended system prompt from the fragment library
   * + spawn facts, write it, return the path (null → no append). Absent → the
   * spec's own systemPromptFile is used unchanged (legacy/tests). */
  assembleSystemPromptFile?(spec: SpawnWorkerSpec, id: string): Promise<string | null>;
}

export function createClaudeCliBackend(deps: ClaudeCliBackendDeps): AgentBackend {
  const sessionFor = (workerId: string, port: number, pid: number | null): AgentSession => ({
    workerId,
    handle: { kind: "http", port, pid },
    capabilities: CLI_CAPS,
    sendMessage: (text, record) => deps.client.sendMessage(port, text, record),
    sendKeystroke: (keys) => deps.client.sendKeystroke(port, keys),
    interrupt: () => deps.client.sendInterrupt(port),
    stop: (graceMs) => deps.supervisor.escalateKill(workerId, graceMs),
    isAlive: () => deps.supervisor.has(workerId),
  });

  return {
    kind: "claude-cli",
    async start(spec: AgentLaunchSpec, cb?: AgentStartCallbacks): Promise<AgentSession> {
      // The claude-cli-specific spawn spec (worktree/branch/gateway/mcp) rides in
      // backendOptions.spec; buildArgs/buildEnv consume it unchanged.
      const raw = (spec.backendOptions?.spec ?? {}) as SpawnWorkerSpec;
      // DPI assembly chokepoint — every claude-cli spawn (worker, orchestrator,
      // resume) funnels through here, so the appended system prompt is built in
      // exactly one place from the fragment library + the resolved spawn facts.
      const systemPromptFile = deps.assembleSystemPromptFile
        ? (await deps.assembleSystemPromptFile(raw, spec.workerId)) ?? undefined
        : raw.systemPromptFile;
      const finalSpec: SpawnWorkerSpec = { ...raw, systemPromptFile };
      const port = await deps.ports.allocate();
      const args = deps.buildArgs({ id: spec.workerId, port, spec: finalSpec, model: spec.model });
      const env = deps.buildEnv({ id: spec.workerId, spec: finalSpec });
      const proc = deps.supervisor.spawn(spec.workerId, {
        args,
        env,
        logFile: deps.logFileFor(spec.workerId),
        onSpawn: (pid) => cb?.onSpawn?.({ kind: "http", port, pid }),
        onExit: (code) => {
          deps.ports.release(port);
          cb?.onExit?.(code);
        },
      });
      return sessionFor(spec.workerId, port, proc.pid);
    },
    attach(workerId: string, handle: WorkerHandle): AgentSession {
      const port = handle.kind === "http" ? handle.port : 0;
      const pid = handle.kind === "http" ? handle.pid : null;
      return sessionFor(workerId, port, pid);
    },
  };
}
