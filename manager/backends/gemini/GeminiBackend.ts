// The gemini-cli AgentBackend: drives the Gemini CLI's ACP server (`gemini --acp`,
// JSON-RPC over stdio), one process + ACP session per worker, billed to the user's
// Google plan through the Gemini CLI's "Log in with Google" on this Mac (API-key
// env vars are stripped, so a stray GEMINI_API_KEY can't move it onto the
// metered API).
//
// Permissions: sessions run in Gemini's "default" approval mode, so every edit,
// command and web fetch comes back as a session/request_permission request —
// answered by the SAME PolicyGatewayService the claude lane uses (a command as
// Bash, an edit as Edit/Write), against the worker's live mode. Answers are always
// one-off: an "always allow" would let Gemini skip the gateway for the rest of the
// session. Eos's own MCP servers are pre-approved by a Gemini policy file, like
// the claude lane's builtins.
//
// ACP has no system-prompt channel, so Eos's per-spawn instructions (DPI) ride
// the first prompt of each fresh session.

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type {
  AgentBackend, AgentSession, AgentLaunchSpec, AgentStartCallbacks, AgentCapabilities, BackendDescriptor, WorkerHandle,
} from "../../../core/src/ports/AgentBackend.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";
import { errMsg } from "../../../contracts/src/util.ts";
import type { PolicyDecider } from "../sdk/SdkPermissionBridge.ts";
import { openAcpAgent, type AcpClient, type AcpOptions } from "./AcpClient.ts";
import { createGeminiEventMapper, eosToolCall, type GeminiEventMapper } from "./GeminiEventMapper.ts";

const CAPS: AgentCapabilities = {
  interrupt: true,
  keystroke: false,
  rewind: false,
  // session/set_model applies to the next prompt.
  runtimeModelSwitch: true,
  // Modes are enforced per permission request against the worker's live mode.
  runtimePermissionSwitch: true,
  streamingThinking: true,
  // session/load replays a saved Gemini chat.
  resumable: true,
  // /clear starts a fresh session on the same process.
  contextClear: true,
  // Gemini compresses its own chats; Eos's summarizer never reads them.
  contextCompaction: false,
  expandsSlashTemplates: false,
};

const MODELS_TTL_MS = 10 * 60_000;

// Only these reach the gateway; anything else Gemini asks about (its own
// ask_user, plan-mode exit, memory or skill tools) has no Eos surface — declined.
const GATED_KINDS = new Set(["execute", "edit", "delete", "move", "fetch"]);

type Params = Record<string, unknown>;
type Emit = (e: AgentEvent) => void;

/** An ACP stdio MCP server (session/new's mcpServers entries). */
export interface AcpMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface GeminiBackendDeps {
  /** The resolved Gemini CLI; null disables the lane. */
  binary: string | null;
  policy: PolicyDecider;
  /** Env for the CLI — the daemon's, minus API-key billing winners. */
  env(): Record<string, string | undefined>;
  /** Eos's stdio MCP servers for this spawn. */
  mcpServersFor(spec: AgentLaunchSpec): AcpMcpServer[];
  /** Every name mcpServersFor may use — pre-approved, and how their tools are named. */
  eosMcpServers: readonly string[];
  /** Where the Gemini policy file that pre-approves them is written. */
  policyFile: string;
  /** DPI: the per-spawn Eos protocol + injected memory. */
  assembleInstructions?(spec: AgentLaunchSpec): string | null;
  open?: (opts: AcpOptions) => Promise<AcpClient>;
  log?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

// The policy engine's user tier, allowing every tool of the named MCP servers.
export function eosMcpPolicy(servers: readonly string[]): string {
  return servers.map((s) => `[[rule]]\nmcpName = ${JSON.stringify(s)}\ndecision = "allow"\npriority = 900\n`).join("\n");
}

// Gemini's own model ids ("gemini-2.5-pro", "auto-gemini-3", …). Anything else — a
// Claude alias the composer carried over, another provider's id — is dropped, so
// Gemini keeps its own default instead of failing the turn.
const geminiModel = (model: string | null | undefined): string | null =>
  model && /^(auto-)?gemini-/i.test(model) ? model : null;

const withInstructions = (instructions: string, text: string): Params[] => [
  { type: "text", text: `<eos-instructions>\n${instructions}\n</eos-instructions>` },
  { type: "text", text },
];

interface Live {
  client: AcpClient;
  sessionId: string;
  model: string | null;
  mapper: GeminiEventMapper;
  alive: boolean;
  /** The in-flight prompt, settled once its end events are out. */
  turn: Promise<void> | null;
  /** Messages sent mid-turn — a new session/prompt would cancel the running one. */
  queued: string[];
  /** DPI text for this spawn; a fresh session hasn't seen it yet while pending. */
  instructions: string | null;
  instructionsPending: boolean;
  onExit?: (code: number) => void;
}

export function createGeminiBackend(deps: GeminiBackendDeps): AgentBackend & { listModels(): Promise<string[]> } {
  const open = deps.open ?? openAcpAgent;
  const live = new Map<string, Live>();
  const emitters = new Map<string, Emit>();
  const restarts = new Map<string, () => Promise<void>>();
  let models: { at: number; ids: string[] } | null = null;

  const descriptor: BackendDescriptor = {
    kind: "gemini-cli", label: "Gemini", processModel: "in-process",
    billing: "subscription", modelSource: "request", capabilities: CAPS,
    models: { kind: "openai-compatible" }, auth: "subscription", enabled: deps.binary !== null,
    sessionStore: "gemini-session",
  };

  const openAgent = (cwd?: string): Promise<AcpClient> => {
    if (!deps.binary) throw new Error("Gemini CLI isn't installed on this Mac.");
    // Rewritten per spawn: a temp dir may be swept while the daemon runs.
    writeFileSync(deps.policyFile, eosMcpPolicy(deps.eosMcpServers));
    return open({
      binary: deps.binary,
      args: ["--approval-mode", "default", "--policy", deps.policyFile],
      env: deps.env(),
      ...(cwd ? { cwd } : {}),
    });
  };

  const decide = async (workerId: string, toolName: string, input: Record<string, unknown>): Promise<boolean> => {
    try {
      return (await deps.policy.decide({ workerId, toolName, input })).behavior === "allow";
    } catch {
      return false;
    }
  };

  const answerPermission = async (workerId: string, p: Params): Promise<unknown> => {
    const toolCall = (p.toolCall ?? {}) as Params;
    const options = (Array.isArray(p.options) ? p.options : []) as Array<{ optionId: string; kind: string }>;
    const choose = (kind: "allow_once" | "reject_once") => {
      const option = options.find((o) => o.kind === kind);
      return { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } };
    };
    const call = eosToolCall(toolCall, deps.eosMcpServers);
    const rec = live.get(workerId);
    const emit = emitters.get(workerId);
    if (rec && emit) for (const e of rec.mapper.announce(toolCall)) emit(e);

    const gated = GATED_KINDS.has(String(toolCall.kind)) || call.name.startsWith("mcp_");
    if (gated && (await decide(workerId, call.name, call.input))) return choose("allow_once");
    if (rec && emit) for (const e of rec.mapper.declined(String(toolCall.toolCallId ?? ""))) emit(e);
    return choose("reject_once");
  };

  const runTurn = (workerId: string, rec: Live, text: string): void => {
    const emit = emitters.get(workerId) ?? (() => {});
    const prompt = rec.instructionsPending && rec.instructions ? withInstructions(rec.instructions, text) : [{ type: "text", text }];
    rec.instructionsPending = false;
    const mapper = rec.mapper;
    for (const e of mapper.startTurn()) emit(e);
    rec.turn = rec.client.request<{ stopReason?: string }>("session/prompt", { sessionId: rec.sessionId, prompt })
      .then(
        (r) => mapper.endTurn({ stopReason: r?.stopReason ?? "end_turn" }),
        // e.g. signed out of Google, or the plan's rate limit — settle the worker
        // instead of leaving it WORKING forever.
        (e) => mapper.endTurn({ error: errMsg(e) }),
      )
      .then((events) => {
        rec.turn = null;
        // A crash is reported by the exit handler instead.
        if (!rec.alive) return;
        for (const e of events) emit(e);
        const next = rec.queued.splice(0).join("\n\n");
        if (next) runTurn(workerId, rec, next);
      });
  };

  const session = (workerId: string): AgentSession => ({
    workerId,
    handle: { kind: "inproc", ref: workerId } as WorkerHandle,
    capabilities: CAPS,
    async sendMessage(text: string) {
      const rec = live.get(workerId);
      if (!rec || !rec.alive) return { ok: false, status: 410, body: { error: "session gone" } };
      if (rec.turn) rec.queued.push(text);
      else runTurn(workerId, rec, text);
      return { ok: true, status: 200, body: { ok: true } };
    },
    async sendKeystroke() { return { ok: false }; },
    async interrupt() {
      const rec = live.get(workerId);
      if (rec?.turn) rec.client.notify("session/cancel", { sessionId: rec.sessionId });
      return { ok: true };
    },
    async clearContext() {
      const rec = live.get(workerId);
      const restart = restarts.get(workerId);
      if (!rec || !rec.alive || !restart) return { ok: false };
      // Messages queued for the old context are dropped with it.
      rec.queued = [];
      if (rec.turn) {
        rec.client.notify("session/cancel", { sessionId: rec.sessionId });
        await rec.turn;
      }
      try {
        await restart();
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    async setModel(model: string) {
      const rec = live.get(workerId);
      if (!rec || !rec.alive) return { ok: false, reason: "session gone" };
      const m = geminiModel(model);
      if (!m) return { ok: false, reason: `"${model}" isn't a Gemini model` };
      try {
        await rec.client.request("session/set_model", { sessionId: rec.sessionId, modelId: m });
      } catch (e) {
        return { ok: false, reason: errMsg(e) };
      }
      rec.model = m;
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
    kind: "gemini-cli",
    descriptor,
    async start(spec: AgentLaunchSpec, cb?: AgentStartCallbacks): Promise<AgentSession> {
      const emit: Emit = (e) => cb?.onEvent?.(e);
      const client = await openAgent(spec.cwd);
      const mcpServers = deps.mcpServersFor(spec);
      const mapper = createGeminiEventMapper({ idPrefix: `${spec.workerId}:${Date.now().toString(36)}`, mcpServers: deps.eosMcpServers });
      const rec: Live = {
        client, sessionId: "", model: geminiModel(spec.model), mapper, alive: true, turn: null, queued: [],
        instructions: deps.assembleInstructions?.(spec) ?? null, instructionsPending: true, ...(cb?.onExit ? { onExit: cb.onExit } : {}),
      };

      client.onRequest(async (method, params) => {
        if (method === "session/request_permission") return answerPermission(spec.workerId, params);
        throw new Error(`unsupported request: ${method}`);
      });
      client.onNotification((method, params) => {
        // Only a running prompt produces output; anything else is a resumed chat's
        // history replay (Eos already has it) or a superseded /clear session.
        if (!rec.alive || method !== "session/update" || !rec.turn || params.sessionId !== rec.sessionId) return;
        for (const e of rec.mapper.update((params.update ?? {}) as Params)) emit(e);
      });
      client.onExit((code) => {
        // Before start() registered the session its own failure is thrown instead.
        if (!rec.alive || live.get(spec.workerId) !== rec) return;
        rec.alive = false;
        live.delete(spec.workerId);
        restarts.delete(spec.workerId);
        emitters.delete(spec.workerId);
        deps.log?.warn("gemini acp agent exited", { workerId: spec.workerId, code, stderr: client.stderrTail().slice(-500) });
        // onExit BEFORE ended — same ordering contract as the claude lane.
        cb?.onExit?.(1);
        emit({ type: "session", phase: "ended", outcome: "crashed" });
      });

      const beginSession = async (resumeId?: string): Promise<void> => {
        let sessionId: string | null = null;
        if (resumeId) {
          try {
            await client.request("session/load", { sessionId: resumeId, cwd: spec.cwd, mcpServers });
            sessionId = resumeId;
          } catch (e) {
            deps.log?.warn("gemini session load failed — starting fresh", { workerId: spec.workerId, error: errMsg(e) });
          }
        }
        if (!sessionId) {
          const res = await client.request<{ sessionId?: string }>("session/new", { cwd: spec.cwd, mcpServers });
          if (!res.sessionId) throw new Error("Gemini returned no session id");
          sessionId = res.sessionId;
        }
        rec.sessionId = sessionId;
        rec.instructionsPending = sessionId !== resumeId;
        if (rec.model) {
          try {
            await client.request("session/set_model", { sessionId, modelId: rec.model });
          } catch (e) {
            deps.log?.warn("gemini model switch failed — keeping its default", { workerId: spec.workerId, model: rec.model, error: errMsg(e) });
          }
        }
        mapper.setModel(rec.model);
        emit({ type: "session", phase: "ready", sessionId });
      };

      cb?.onSpawn?.({ kind: "inproc", ref: spec.workerId });
      emit({ type: "session", phase: "started" });
      try {
        await beginSession(typeof spec.backendOptions?.resume === "string" ? spec.backendOptions.resume : undefined);
      } catch (e) {
        rec.alive = false;
        client.close();
        throw e;
      }

      live.set(spec.workerId, rec);
      emitters.set(spec.workerId, emit);
      restarts.set(spec.workerId, () => beginSession());
      if (spec.prompt) runTurn(spec.workerId, rec, spec.prompt);
      return session(spec.workerId);
    },
    attach(workerId: string): AgentSession {
      return session(workerId);
    },
    async listModels(): Promise<string[]> {
      if (models && Date.now() - models.at < MODELS_TTL_MS) return models.ids;
      const client = await openAgent();
      try {
        // The account's models come with a session; an unused one leaves no chat behind.
        const res = await client.request<{ models?: { availableModels?: Array<{ modelId: string }>; currentModelId?: string } }>(
          "session/new", { cwd: homedir(), mcpServers: [] },
        );
        const available = res.models?.availableModels ?? [];
        const current = res.models?.currentModelId;
        const ids = available
          .map((m) => m.modelId)
          .sort((a, b) => Number(b === current) - Number(a === current));
        models = { at: Date.now(), ids };
        return ids;
      } finally {
        client.close();
      }
    },
  };
}
