// The codex-cli AgentBackend: drives the Codex CLI's `app-server` (JSON-RPC over
// stdio), one server process + thread per session, billed to the user's ChatGPT
// plan through the Codex login on this Mac (API-key env vars are stripped, so a
// stray OPENAI_API_KEY can't move it onto the metered API).
//
// Permissions: the thread runs read-only-sandboxed with approval "untrusted", so
// every write, patch and non-trivial command comes back as an approval request —
// answered by the SAME PolicyGatewayService the claude lane uses (a command as
// Bash, a patched file as Edit/Write), against the worker's live mode. Eos's own
// MCP servers (orchestrator / worker tools) are pre-approved, like the claude
// lane's builtins.

import { resolve } from "node:path";
import type {
  AgentBackend, AgentSession, AgentLaunchSpec, AgentStartCallbacks, AgentCapabilities, BackendDescriptor, WorkerHandle,
} from "../../../core/src/ports/AgentBackend.ts";
import { modelMatchesFamily } from "../../../core/src/domain/model-provider.ts";
import { errMsg } from "../../../contracts/src/util.ts";
import type { PolicyDecider } from "../sdk/SdkPermissionBridge.ts";
import { openAppServer, type AppServerClient, type AppServerOptions } from "./AppServerClient.ts";
import { createCodexEventMapper, unwrapShellCommand, type CodexEventMapper } from "./CodexEventMapper.ts";

const CAPS: AgentCapabilities = {
  interrupt: true,
  keystroke: false,
  rewind: false,
  // The model (and effort) ride every turn/start, so a switch applies to the next turn.
  runtimeModelSwitch: true,
  // Modes are enforced per approval request against the worker's live mode.
  runtimePermissionSwitch: true,
  streamingThinking: true,
  resumable: true,
  // /clear starts a fresh thread on the same server.
  contextClear: true,
  // Codex compacts its own threads; Eos's summarizer never reads them.
  contextCompaction: false,
  expandsSlashTemplates: false,
};

// A user's personal notify hook (e.g. a desktop app's turn-ended ping) must not
// fire for every Eos agent turn.
const SERVER_ARGS = ["-c", "notify=[]"];
const MODELS_TTL_MS = 10 * 60_000;

type Params = Record<string, unknown>;

export interface CodexBackendDeps {
  /** The resolved Codex CLI (resolveCodexBinary); null disables the lane. */
  binary: string | null;
  policy: PolicyDecider;
  /** Env for the app-server — the daemon's, minus API-key billing winners. */
  env(): Record<string, string | undefined>;
  /** Eos's stdio MCP servers for this spawn, in Codex's mcp_servers config shape. */
  mcpServersFor(spec: AgentLaunchSpec): Record<string, unknown>;
  /** DPI: the per-spawn Eos protocol + injected memory, sent as developer instructions. */
  assembleInstructions?(spec: AgentLaunchSpec): string | null;
  open?: (opts: AppServerOptions) => Promise<AppServerClient>;
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

interface Live {
  client: AppServerClient;
  threadId: string;
  turnId: string | null;
  model: string | null;
  effort: string | null;
  mapper: CodexEventMapper;
  alive: boolean;
  /** fileChange items by id — an approval request names the item, not its files. */
  fileChanges: Map<string, Array<{ path: string; kind: string }>>;
  onExit?: (code: number) => void;
}

// An Eos model value that isn't a Codex model (a Claude alias the composer carried
// over) is dropped, so Codex falls back to its own default instead of failing.
const codexModel = (model: string | null | undefined): string | null =>
  model && !modelMatchesFamily(model, "claude") ? model : null;

const textInput = (text: string): Params[] => [{ type: "text", text, text_elements: [] }];

export function createCodexBackend(deps: CodexBackendDeps): AgentBackend & { listModels(): Promise<string[]> } {
  const open = deps.open ?? openAppServer;
  const live = new Map<string, Live>();
  let models: { at: number; ids: string[] } | null = null;

  const descriptor: BackendDescriptor = {
    kind: "codex-cli", label: "Codex", processModel: "in-process",
    billing: "subscription", modelSource: "request", capabilities: CAPS,
    models: { kind: "openai-compatible" }, auth: "subscription", enabled: deps.binary !== null,
    sessionStore: "codex-thread",
  };

  const openServer = (cwd?: string): Promise<AppServerClient> => {
    if (!deps.binary) throw new Error("Codex isn't installed on this Mac.");
    return open({ binary: deps.binary, args: SERVER_ARGS, env: deps.env(), ...(cwd ? { cwd } : {}) });
  };

  const decide = async (workerId: string, toolName: string, input: Record<string, unknown>): Promise<boolean> => {
    try {
      return (await deps.policy.decide({ workerId, toolName, input })).behavior === "allow";
    } catch {
      return false;
    }
  };

  // The server's approval requests, answered by the Eos gateway.
  const answerRequest = async (workerId: string, cwd: string | undefined, method: string, p: Params): Promise<unknown> => {
    const rec = live.get(workerId);
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const input = { command: typeof p.command === "string" ? unwrapShellCommand(p.command) : "", ...(typeof p.reason === "string" ? { description: p.reason } : {}) };
        return { decision: (await decide(workerId, "Bash", input)) ? "accept" : "decline" };
      }
      case "item/fileChange/requestApproval": {
        const changes = rec?.fileChanges.get(String(p.itemId)) ?? [];
        const files = changes.length ? changes : [{ path: cwd ?? "", kind: "update" }];
        for (const c of files) {
          const ok = await decide(workerId, c.kind === "add" ? "Write" : "Edit", { file_path: cwd ? resolve(cwd, c.path) : c.path });
          if (!ok) return { decision: "decline" };
        }
        return { decision: "accept" };
      }
      case "mcpServer/elicitation/request": {
        // A non-Eos MCP server's tool approval (Eos's own are pre-approved).
        const meta = (p._meta ?? {}) as Params;
        if (meta.codex_approval_kind === "mcp_tool_call") {
          const tool = String(meta.tool_name ?? meta.tool_title ?? "tool");
          const args = meta.tool_params && typeof meta.tool_params === "object" ? (meta.tool_params as Record<string, unknown>) : {};
          if (await decide(workerId, `mcp__${String(p.serverName)}__${tool}`, args)) return { action: "accept", content: {}, _meta: null };
        }
        return { action: "decline", content: null, _meta: null };
      }
      // Extra sandbox permissions and in-turn questions have no Eos surface: grant
      // nothing, answer nothing (questions go through the orchestrator's ask_user).
      case "item/permissions/requestApproval":
        return { permissions: {}, scope: "turn" };
      case "item/tool/requestUserInput":
        return { answers: {} };
      default:
        throw new Error(`unsupported request: ${method}`);
    }
  };

  const threadParams = (spec: AgentLaunchSpec, model: string | null, instructions: string | null): Params => ({
    ...(model ? { model } : {}),
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    approvalPolicy: "untrusted",
    sandbox: "read-only",
    ...(instructions ? { developerInstructions: instructions } : {}),
    config: { mcp_servers: deps.mcpServersFor(spec) },
  });

  const startTurn = async (rec: Live, text: string, emit: (e: Parameters<NonNullable<AgentStartCallbacks["onEvent"]>>[0]) => void): Promise<void> => {
    try {
      await rec.client.request("turn/start", {
        threadId: rec.threadId,
        input: textInput(text),
        ...(rec.model ? { model: rec.model } : {}),
        ...(rec.effort ? { effort: rec.effort } : {}),
      });
    } catch (e) {
      // Never started (e.g. signed out of ChatGPT) — settle the worker instead of
      // leaving it WORKING forever.
      emit({ type: "turn", phase: "error", reason: errMsg(e) });
    }
  };

  // Per live worker: its event sink (a steer that fell back to a new turn reports
  // through it) and its /clear restart (a fresh thread on the same server).
  const emitters = new Map<string, (e: Parameters<NonNullable<AgentStartCallbacks["onEvent"]>>[0]) => void>();
  const restarts = new Map<string, () => Promise<void>>();

  const session = (workerId: string): AgentSession => ({
    workerId,
    handle: { kind: "inproc", ref: workerId } as WorkerHandle,
    capabilities: CAPS,
    async sendMessage(text: string) {
      const rec = live.get(workerId);
      if (!rec || !rec.alive) return { ok: false, status: 410, body: { error: "session gone" } };
      if (rec.turnId) {
        // Mid-turn input steers the running turn rather than queueing a new one.
        try {
          await rec.client.request("turn/steer", { threadId: rec.threadId, input: textInput(text), expectedTurnId: rec.turnId });
          return { ok: true, status: 200, body: { ok: true } };
        } catch { /* the turn ended meanwhile — start a new one */ }
      }
      void startTurn(rec, text, emitters.get(workerId) ?? (() => {}));
      return { ok: true, status: 200, body: { ok: true } };
    },
    async sendKeystroke() { return { ok: false }; },
    async interrupt() {
      const rec = live.get(workerId);
      if (rec?.turnId) {
        try { await rec.client.request("turn/interrupt", { threadId: rec.threadId, turnId: rec.turnId }); } catch { /* already over */ }
      }
      return { ok: true };
    },
    async clearContext() {
      const rec = live.get(workerId);
      const restart = rec ? restarts.get(workerId) : undefined;
      if (!rec || !rec.alive || !restart) return { ok: false };
      try {
        await restart();
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async setModel(model: string, effort?: string) {
      const rec = live.get(workerId);
      if (!rec || !rec.alive) return { ok: false, reason: "session gone" };
      const m = codexModel(model);
      if (!m) return { ok: false, reason: `"${model}" isn't a Codex model` };
      rec.model = m;
      if (effort) rec.effort = effort;
      rec.mapper.setModel(m);
      return { ok: true };
    },
    stop() {
      const rec = live.get(workerId);
      if (!rec || !rec.alive) return;
      rec.alive = false;
      live.delete(workerId);
      restarts.delete(workerId);
      emitters.delete(workerId);
      rec.client.close();
      rec.onExit?.(143);
    },
    isAlive() { return live.get(workerId)?.alive ?? false; },
  });

  return {
    kind: "codex-cli",
    descriptor,
    async start(spec: AgentLaunchSpec, cb?: AgentStartCallbacks): Promise<AgentSession> {
      const emit = (e: Parameters<NonNullable<AgentStartCallbacks["onEvent"]>>[0]): void => cb?.onEvent?.(e);
      const client = await openServer(spec.cwd);
      const mapper = createCodexEventMapper();
      const instructions = deps.assembleInstructions?.(spec) ?? null;
      const model = codexModel(spec.model);
      const rec: Live = {
        client, threadId: "", turnId: null, model, effort: spec.effort ?? null, mapper, alive: true,
        fileChanges: new Map(), ...(cb?.onExit ? { onExit: cb.onExit } : {}),
      };

      client.onRequest((method, params) => answerRequest(spec.workerId, spec.cwd, method, params));
      client.onNotification((method, params) => {
        if (!rec.alive) return;
        if (typeof params.threadId === "string" && params.threadId !== rec.threadId) return; // a superseded /clear thread
        if (method === "turn/started") rec.turnId = String((params.turn as Params | undefined)?.id ?? "") || null;
        if (method === "turn/completed") { rec.turnId = null; rec.fileChanges.clear(); }
        if (method === "item/started" || method === "item/completed") {
          const item = params.item as Params | undefined;
          if (item?.type === "fileChange" && Array.isArray(item.changes)) {
            rec.fileChanges.set(String(item.id), (item.changes as Params[]).map((c) => ({ path: String(c.path ?? ""), kind: String((c.kind as Params | undefined)?.type ?? "update") })));
          }
        }
        for (const e of mapper.map(method, params)) emit(e);
      });
      client.onExit((code) => {
        // Before start() registered the session its own failure is thrown instead.
        if (!rec.alive || live.get(spec.workerId) !== rec) return;
        rec.alive = false;
        live.delete(spec.workerId);
        restarts.delete(spec.workerId);
        emitters.delete(spec.workerId);
        deps.log?.warn("codex app-server exited", { workerId: spec.workerId, code, stderr: client.stderrTail().slice(-500) });
        // onExit BEFORE ended — same ordering contract as the claude lane (the exit
        // handler must see the row before ENDING to suspend a resumable session).
        cb?.onExit?.(1);
        emit({ type: "session", phase: "ended", outcome: "crashed" });
      });

      type ThreadResult = { thread?: { id?: string }; model?: string };
      const beginThread = async (resumeId?: string): Promise<void> => {
        let res: ThreadResult | null = null;
        if (resumeId) {
          try {
            res = await client.request<ThreadResult>("thread/resume", { threadId: resumeId, ...threadParams(spec, rec.model, instructions) });
          } catch (e) {
            deps.log?.warn("codex thread resume failed — starting fresh", { workerId: spec.workerId, error: errMsg(e) });
          }
        }
        res ??= await client.request<ThreadResult>("thread/start", threadParams(spec, rec.model, instructions));
        const threadId = res.thread?.id;
        if (!threadId) throw new Error("Codex returned no thread id");
        rec.threadId = threadId;
        rec.turnId = null;
        mapper.setModel(res.model ?? rec.model);
        emit({ type: "session", phase: "ready", sessionId: threadId });
      };

      cb?.onSpawn?.({ kind: "inproc", ref: spec.workerId });
      emit({ type: "session", phase: "started" });
      try {
        await beginThread(typeof spec.backendOptions?.resume === "string" ? spec.backendOptions.resume : undefined);
      } catch (e) {
        rec.alive = false;
        client.close();
        throw e;
      }

      live.set(spec.workerId, rec);
      emitters.set(spec.workerId, emit);
      restarts.set(spec.workerId, () => beginThread());
      if (spec.prompt) void startTurn(rec, spec.prompt, emit);
      return session(spec.workerId);
    },
    attach(workerId: string): AgentSession {
      return session(workerId);
    },
    async listModels(): Promise<string[]> {
      if (models && Date.now() - models.at < MODELS_TTL_MS) return models.ids;
      const client = await openServer();
      try {
        const res = await client.request<{ data?: Array<{ id: string; model?: string; hidden?: boolean; isDefault?: boolean }> }>("model/list", { limit: 100 });
        const ids = (res.data ?? [])
          .filter((m) => !m.hidden)
          .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)))
          .map((m) => m.model ?? m.id);
        models = { at: Date.now(), ids };
        return ids;
      } finally {
        client.close();
      }
    },
  };
}
