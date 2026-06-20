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
  AgentBackend, AgentSession, AgentLaunchSpec, AgentStartCallbacks, AgentCapabilities, BackendDescriptor, WorkerHandle,
} from "../../../core/src/ports/AgentBackend.ts";
import type { AuthResolver } from "../../../core/src/ports/AuthResolver.ts";
import type { ToolContext } from "../../tools/types.ts";
import { createSdkEventMapper } from "./SdkEventMapper.ts";
import { buildBillingGuardEnv } from "./billing-env.ts";
import { buildSdkToolServers, type SdkToolHostDeps } from "./SdkToolHost.ts";
import { makeCanUseTool, type PolicyDecider } from "./SdkPermissionBridge.ts";
import { disallowedBuiltinToolsFor } from "../../../contracts/src/tool-scope.ts";

const CAPS: AgentCapabilities = {
  interrupt: true,
  keystroke: false,
  // query.setModel takes effect mid-session in streaming-input mode (the mode we
  // run) — wired in the session's setModel below. (effort has no live SDK lever;
  // it's persisted by SetWorkerModel and applied on the next resume.)
  runtimeModelSwitch: true,
  runtimePermissionSwitch: false,
  streamingThinking: true,
  resumable: true,
  // /clear restarts the query with a fresh session (no resume) — the conversation
  // lives in the SDK subprocess, so there is no buffer to drop. See clearContext.
  contextClear: true,
};

const SDK_DESCRIPTOR: BackendDescriptor = {
  kind: "claude-sdk", label: "Claude SDK", processModel: "in-process",
  billing: "subscription", modelSource: "request", capabilities: CAPS,
  models: { kind: "claude" }, auth: "subscription", enabled: true,
  sessionStore: "claude-transcript",
};

type SdkMsg = Parameters<ReturnType<typeof createSdkEventMapper>["map"]>[0];

// The SDK message stream query() yields, plus its control methods. Injected as a
// seam so tests script it.
export interface SdkQueryHandle extends AsyncIterable<unknown> {
  interrupt?(): Promise<void>;
  setModel?(model?: string): Promise<void>;
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
  /** DPI: assemble the worker's appended system-prompt text (the same fragments
   *  the CLI lane writes to --append-system-prompt-file). Absent/null → no append.
   *  Without it an SDK agent boots with only the stock claude_code prompt and never
   *  learns the Eos orchestration protocol — so it has the MCP tools but ignores them. */
  assembleAppendPrompt?(spec: AgentLaunchSpec): string | null;
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
  // Set by interrupt() before q.interrupt(); guards the stream-completion branch
  // so an interrupt that ends the query iterator is reported as an interrupt
  // (143 + turn:aborted), never a spurious clean exit (code 0 → markDone).
  interrupting: boolean;
  onExit?: (code: number | null) => void;
  // /clear: tear down the current query and start a fresh one (new session, no
  // resume, empty context). The session row stays alive across the swap.
  relaunch?: () => void;
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
      s.interrupting = false; // a new turn means the session continued past any interrupt
      s.input.push(text);
      return { ok: true, status: 200, body: { ok: true } };
    },
    async sendKeystroke() { return { ok: false }; },
    async interrupt() {
      const s = live.get(workerId);
      if (s) s.interrupting = true;
      if (s?.q?.interrupt) { try { await s.q.interrupt(); } catch { /* best-effort */ } }
      return { ok: true };
    },
    // /clear: the conversation lives in the SDK subprocess, so there is no buffer
    // to reset — restart the query with a fresh session (no resume) instead. The
    // OLD input/query are captured and torn down AFTER relaunch swaps rec.input to
    // the new stream, so the old consume loop sees it is no longer current
    // (isCurrent() false) and stays silent — no spurious onExit for the session.
    async clearContext() {
      const s = live.get(workerId);
      if (!s || !s.alive) return { ok: false };
      const oldInput = s.input;
      const oldQ = s.q;
      s.relaunch?.();
      oldInput.close();
      if (oldQ?.interrupt) { try { await oldQ.interrupt(); } catch { /* best-effort */ } }
      return { ok: true };
    },
    // Runtime model switch via the SDK Query control method (streaming-input
    // only). effort is ignored here — the SDK has no /effort equivalent; it's
    // persisted by the caller and applied at the next resume.
    async setModel(model: string) {
      const s = live.get(workerId);
      if (!s || !s.alive) return { ok: false, reason: "session gone" };
      if (!s.q?.setModel) return { ok: false, reason: "setModel unavailable" };
      try { await s.q.setModel(model); return { ok: true }; }
      catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
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
    descriptor: SDK_DESCRIPTOR,
    async start(spec: AgentLaunchSpec, cb?: AgentStartCallbacks): Promise<AgentSession> {
      const opts = spec.backendOptions ?? {};
      const auth = await deps.authResolver.resolve(opts.auth);
      const env = buildBillingGuardEnv({ auth, workerId: spec.workerId, daemonUrl: deps.daemonUrl });
      const ctx = deps.makeToolContext(spec);
      const { mcpServers, allowedTools } = buildSdkToolServers(deps.toolHost, {
        isOrchestrator: spec.isOrchestrator,
        collaborate: opts.collaborate === true,
        ctx,
      });

      // The Eos orchestration protocol + injected project/user memory (CLAUDE.md,
      // …) ride in the appended system prompt. The container assembles both into
      // this text (assembleAppendFor → DPI + selectInjectableMemory); settingSources:[]
      // below drops the binary's own memory auto-load, so this is the SDK lane's
      // only memory channel.
      const append = deps.assembleAppendPrompt?.(spec) ?? null;

      // Options shared by the initial launch AND any /clear restart. `resume` is
      // added per-launch — the initial honors backendOptions.resume; a clear
      // restart never resumes (fresh session, empty context).
      const baseOptions = {
        model: spec.model,
        // Run the SDK session in the worker's resolved directory (plain cwd, or
        // the materialized worktree). Without this the SDK defaults to the
        // daemon's process.cwd() and the agent reads/edits the wrong tree.
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        env,
        mcpServers,
        // allowedTools stays EMPTY (from SdkToolHost): an allow-listed tool bypasses
        // canUseTool. Keeping Eos tools out routes EVERY call (built-ins + mcp__*)
        // through canUseTool → PolicyGatewayService, like the PTY hook-as-gateway.
        allowedTools,
        // Hard-remove AskUserQuestion regardless of permission mode (it has no answer
        // surface in Eos; redirect to mcp__orchestrator__ask_user) — platform-wide deny.
        // Orchestrators additionally lose Task (they dispatch via spawn_worker, not
        // internal subagents); workers keep it. Keyed on the immutable isOrchestrator fact.
        disallowedTools: disallowedBuiltinToolsFor(spec.isOrchestrator),
        canUseTool: makeCanUseTool(spec.workerId, deps.policy),
        includePartialMessages: true,
        // Isolate from the user's ~/.claude: no ambient MCP servers / settings-file
        // tools leak in to drown Eos's tools (mirrors the PTY --strict-mcp-config).
        settingSources: [] as Options["settingSources"],
        strictMcpConfig: true,
        // display:"summarized" is required to stream thinking on Opus 4.7+ (it
        // otherwise defaults to omitted) — proven by the spike.
        thinking: (opts.thinking as Options["thinking"]) ?? ({ type: "adaptive", display: "summarized" } as Options["thinking"]),
        ...(append ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append } } : {}),
        // bypassPermissions requires the explicit safety flag; else pass the mode through.
        ...(spec.permissionMode === "bypassPermissions"
              ? { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true }
              : spec.permissionMode ? { permissionMode: spec.permissionMode as Options["permissionMode"] } : {}),
      } as Options;

      const rec: Live = { q: null, input: createPushStream(), alive: true, interrupting: false, onExit: cb?.onExit };
      live.set(spec.workerId, rec);
      cb?.onSpawn?.({ kind: "inproc", ref: spec.workerId });
      cb?.onEvent?.({ type: "session", phase: "started" });

      // Launch (or, on /clear, relaunch) a query. Each launch owns its own input
      // stream + mapper; the consume loop guards on `rec.input === input`, so a
      // launch superseded by a clear-restart ends SILENTLY (no spurious onExit) —
      // the new query owns the session row.
      const spawn = (resume?: string, initialPrompt?: string): void => {
        const input = createPushStream();
        rec.input = input;
        const options = { ...baseOptions, ...(resume ? { resume } : {}) } as Options;
        const mapper = createSdkEventMapper();
        const q = queryFn({ prompt: input.iterable, options });
        rec.q = q;
        if (initialPrompt) input.push(initialPrompt);
        const isCurrent = (): boolean => rec.input === input;
        // Consume the SDK stream in the background — the session is "started", not
        // "settled"; turn completion is observed via the event stream (turn:ended).
        void (async () => {
          try {
            for await (const msg of q) {
              if (!isCurrent()) return; // superseded by a /clear restart → stay silent
              for (const e of mapper.map(msg as SdkMsg)) cb?.onEvent?.(e);
            }
            if (!isCurrent()) return;
            if (rec.alive) {
              rec.alive = false;
              live.delete(spec.workerId);
              // The input stream stays open across interrupt(), so the loop should
              // not end on a mere interrupt; if it did, report it as an interrupt
              // (143) — not a clean exit the daemon would record as a normal finish.
              if (rec.interrupting) { cb?.onEvent?.({ type: "turn", phase: "aborted", reason: "interrupted" }); cb?.onExit?.(143); }
              else cb?.onExit?.(0);
            }
          } catch (e) {
            if (!isCurrent()) return;
            deps.log?.warn("claude-sdk query failed", { workerId: spec.workerId, error: e instanceof Error ? e.message : String(e) });
            if (rec.alive) {
              rec.alive = false;
              live.delete(spec.workerId);
              cb?.onEvent?.({ type: "session", phase: "ended", outcome: "crashed" });
              cb?.onExit?.(1);
            }
          }
        })();
      };

      rec.relaunch = () => spawn(undefined, undefined);
      spawn(typeof opts.resume === "string" ? opts.resume : undefined, spec.prompt || undefined);

      return session(spec.workerId);
    },
    attach(workerId: string): AgentSession {
      return session(workerId);
    },
  };
}
