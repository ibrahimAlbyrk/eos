// Lane A: the claude-sdk AgentBackend. Drives @anthropic-ai/claude-agent-sdk's
// query() in streaming-input mode (one query per session; sendMessage pushes a
// new user turn), maps SDK messages to canonical AgentEvents via SdkEventMapper,
// and bills the Max/Pro subscription via the billing-env guard. Subscription
// streaming thinking with structured I/O — the replacement for the fragile PTY.
//
// The SDK spawns the bundled `claude` binary as a subprocess; "in-process" here
// means Eos's tool host + event sink, not the model loop. The queryFn seam lets
// tests drive a scripted SDK stream (FakeSdkQuery) with no real model / no billing.

import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentBackend, AgentSession, AgentLaunchSpec, AgentStartCallbacks, AgentCapabilities, WorkerHandle,
} from "../../../core/src/ports/AgentBackend.ts";
import type { AuthResolver } from "../../../core/src/ports/AuthResolver.ts";
import type { AuthRef } from "../../../contracts/src/backend.ts";
import type { ToolContext } from "../../tools/types.ts";
import { createSdkEventMapper } from "./SdkEventMapper.ts";
import { buildBillingGuardEnv } from "./billing-env.ts";
import { buildSdkToolServers, type SdkToolHostDeps } from "./SdkToolHost.ts";
import { makeCanUseTool, type PolicyDecider } from "./SdkPermissionBridge.ts";

const CAPS: AgentCapabilities = {
  interrupt: true,
  keystroke: false,
  // query.setModel / setPermissionMode exist; advertised false until the spike
  // verifies they take effect mid-session (flipped in the cutover phase).
  runtimeModelSwitch: false,
  runtimePermissionSwitch: false,
  streamingThinking: true,
  resumable: true,
};

type SdkMsg = Parameters<ReturnType<typeof createSdkEventMapper>["map"]>[0];

// The SDK message stream query() yields, plus its control methods. Injected as a
// seam so tests script it.
export interface SdkQueryHandle extends AsyncIterable<unknown> {
  interrupt?(): Promise<void>;
}
export type SdkQueryFn = (params: { prompt: AsyncIterable<unknown>; options: Options }) => SdkQueryHandle;

export interface ClaudeSdkBackendDeps {
  authResolver: AuthResolver;
  policy: PolicyDecider;
  toolHost: SdkToolHostDeps;
  daemonUrl: string;
  /** Build the per-spec ToolContext (identity bound from the spec, never
   *  process.env) — supplies the loopback `api` + cwd + git probe. */
  makeToolContext(spec: AgentLaunchSpec): ToolContext;
  queryFn?: SdkQueryFn;
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

interface PushStream {
  push(text: string): void;
  close(): void;
  iterable: AsyncIterable<unknown>;
}

function createPushStream(): PushStream {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const userMessage = (text: string) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
  return {
    push(text: string) { queue.push(userMessage(text)); wake?.(); wake = null; },
    close() { closed = true; wake?.(); wake = null; },
    iterable: (async function* () {
      while (!closed || queue.length) {
        if (queue.length) { yield queue.shift(); continue; }
        await new Promise<void>((r) => { wake = r; });
      }
    })(),
  };
}

interface Live {
  q: SdkQueryHandle | null;
  input: PushStream;
  alive: boolean;
  onExit?: (code: number | null) => void;
}

export function createClaudeSdkBackend(deps: ClaudeSdkBackendDeps): AgentBackend {
  const queryFn: SdkQueryFn = deps.queryFn ?? ((p) => realQuery(p as never) as unknown as SdkQueryHandle);
  const live = new Map<string, Live>();

  const session = (workerId: string): AgentSession => ({
    workerId,
    handle: { kind: "inproc", ref: workerId } as WorkerHandle,
    capabilities: CAPS,
    async sendMessage(text: string) {
      const s = live.get(workerId);
      if (!s || !s.alive) return { ok: false, status: 410, body: { error: "session gone" } };
      s.input.push(text);
      return { ok: true, status: 200, body: { ok: true } };
    },
    async sendKeystroke() { return { ok: false }; },
    async interrupt() {
      const s = live.get(workerId);
      if (s?.q?.interrupt) { try { await s.q.interrupt(); } catch { /* best-effort */ } }
      return { ok: true };
    },
    stop() {
      const s = live.get(workerId);
      if (!s || !s.alive) return;
      s.alive = false;
      s.input.close();
      live.delete(workerId);
      s.onExit?.(143);
    },
    isAlive() { return live.get(workerId)?.alive ?? false; },
  });

  return {
    kind: "claude-sdk",
    async start(spec: AgentLaunchSpec, cb?: AgentStartCallbacks): Promise<AgentSession> {
      const opts = (spec.backendOptions ?? {}) as Record<string, unknown>;
      const auth = await deps.authResolver.resolve(opts.auth as AuthRef | undefined);
      const env = buildBillingGuardEnv({ auth, workerId: spec.workerId, daemonUrl: deps.daemonUrl });
      const ctx = deps.makeToolContext(spec);
      const { mcpServers, allowedTools } = buildSdkToolServers(deps.toolHost, {
        isOrchestrator: spec.isOrchestrator,
        collaborate: opts.collaborate === true,
        ctx,
      });

      const input = createPushStream();
      if (spec.prompt) input.push(spec.prompt);

      const options = {
        model: spec.model,
        env,
        mcpServers,
        allowedTools,
        canUseTool: makeCanUseTool(spec.workerId, deps.policy),
        includePartialMessages: true,
        thinking: (opts.thinking as Options["thinking"]) ?? { type: "adaptive" },
        ...(spec.permissionMode ? { permissionMode: spec.permissionMode as Options["permissionMode"] } : {}),
        ...(typeof opts.resume === "string" ? { resume: opts.resume } : {}),
      } as Options;

      const rec: Live = { q: null, input, alive: true, onExit: cb?.onExit };
      live.set(spec.workerId, rec);
      cb?.onSpawn?.({ kind: "inproc", ref: spec.workerId });
      cb?.onEvent?.({ type: "session", phase: "started" });

      const mapper = createSdkEventMapper();
      const q = queryFn({ prompt: input.iterable, options });
      rec.q = q;

      // Consume the SDK stream in the background — the session is "started", not
      // "settled"; turn completion is observed via the event stream (turn:ended).
      void (async () => {
        try {
          for await (const msg of q) {
            for (const e of mapper.map(msg as SdkMsg)) cb?.onEvent?.(e);
          }
          if (rec.alive) { rec.alive = false; live.delete(spec.workerId); cb?.onExit?.(0); }
        } catch (e) {
          deps.log?.warn("claude-sdk query failed", { workerId: spec.workerId, error: e instanceof Error ? e.message : String(e) });
          if (rec.alive) {
            rec.alive = false;
            live.delete(spec.workerId);
            cb?.onEvent?.({ type: "session", phase: "ended", outcome: "crashed" });
            cb?.onExit?.(1);
          }
        }
      })();

      return session(spec.workerId);
    },
    attach(workerId: string): AgentSession {
      return session(workerId);
    },
  };
}
