// Lane A: the claude-sdk AgentBackend. Drives @anthropic-ai/claude-agent-sdk's
// query() in streaming-input mode (one query per session; sendMessage pushes a
// new user turn), maps SDK messages to canonical AgentEvents via SdkEventMapper,
// and bills the Max/Pro subscription via the billing-env guard. Subscription
// streaming thinking with structured I/O — the replacement for the fragile PTY.
//
// The SDK spawns the bundled `claude` binary as a subprocess; "in-process" here
// means Eos's tool host + event sink, not the model loop. The queryFn seam lets
// tests drive a scripted SDK stream (FakeSdkQuery) with no real model / no billing.

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { query as realQuery, forkSession as realForkSession } from "@anthropic-ai/claude-agent-sdk";
import type { Options, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { DroppedServer } from "./SdkMcpTranslator.ts";
import type {
  AgentBackend, AgentSession, AgentLaunchSpec, AgentStartCallbacks, AgentCapabilities, BackendDescriptor, WorkerHandle,
} from "../../../core/src/ports/AgentBackend.ts";
import { backendCollaborate, backendRole } from "../../../core/src/ports/AgentBackend.ts";
import type { RewindResult } from "../../../core/src/ports/WorkerClient.ts";
import { computeRewindTargets, rewindSliceAnchor, type RewindTarget } from "../../../core/src/domain/rewind-targets.ts";
import { encodeCwd } from "../../../core/src/domain/claude-paths.ts";
import type { AuthResolver } from "../../../core/src/ports/AuthResolver.ts";
import type { ToolContext } from "../../tools/types.ts";
import { createSdkEventMapper, type SdkEventMapper } from "./SdkEventMapper.ts";
import { buildBillingGuardEnv } from "./billing-env.ts";
import { buildSdkToolServers, type SdkToolHostDeps } from "./SdkToolHost.ts";
import { makeCanUseTool, type PolicyDecider } from "./SdkPermissionBridge.ts";
import { disallowedBuiltinToolsFor } from "../../../contracts/src/tool-scope.ts";

const CAPS: AgentCapabilities = {
  interrupt: true,
  keystroke: false,
  // Rewind is decoupled from keystroke (ISP): realized via the SDK's forkSession
  // (roll the conversation back) + Query.rewindFiles (restore code), NOT a raw
  // keystroke channel — so keystroke stays false while rewind is true. The rewind
  // route + UI panel gate on THIS flag (see getRewindTargets/rewind below).
  rewind: true,
  // query.setModel takes effect mid-session in streaming-input mode (the mode we
  // run) — wired in the session's setModel below. (effort IS applied at start()/
  // resume via the Options.effort field; only LIVE in-session switching is unwired.)
  runtimeModelSwitch: true,
  runtimePermissionSwitch: false,
  streamingThinking: true,
  resumable: true,
  // /clear restarts the query with a fresh session (no resume) — the conversation
  // lives in the SDK subprocess, so there is no buffer to drop. See clearContext.
  contextClear: true,
  // The bundled binary (driven by the SDK) expands prompt-template .md slash-commands
  // itself — Eos must NOT double-expand (DispatchMessage gates on this, never kind).
  expandsSlashTemplates: true,
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
  // Restore tracked files to their state at a user message (the code-rewind
  // primitive). Only effective when file checkpointing is enabled — returns
  // canRewind:false otherwise. Present on the real Query; scripted in tests.
  rewindFiles?(userMessageId: string, options?: { dryRun?: boolean }): Promise<{ canRewind: boolean; error?: string; filesChanged?: string[]; insertions?: number; deletions?: number }>;
}
export type SdkQueryFn = (params: { prompt: AsyncIterable<unknown>; options: Options }) => SdkQueryHandle;

// Slices a session transcript up to (and including) a message uuid into a new
// resumable session — the recall primitive (Layer 2). Injected as a seam so
// tests assert the slice without touching disk. Mirrors the real SDK forkSession.
export type ForkSessionFn = (sessionId: string, options: { dir?: string; upToMessageId?: string }) => Promise<{ sessionId: string }>;

export interface ClaudeSdkBackendDeps {
  authResolver: AuthResolver;
  policy: PolicyDecider;
  toolHost: SdkToolHostDeps;
  daemonUrl: string;
  /** Operator-configured Anthropic credentials (~/.eos/config.json `anthropic`).
   *  Read LIVE per spawn so a Settings save takes effect without a daemon restart.
   *  authToken (OAuth) wins over apiKey; injected into the child env by
   *  buildBillingGuardEnv. Omitted (tests/spikes) ⇒ no config-provided creds. */
  getAnthropicConfig?: () => { apiKey?: string; authToken?: string };
  /** Build the per-spec ToolContext (identity bound from the spec, never
   *  process.env) — supplies the loopback `api` + cwd + git probe. */
  makeToolContext(spec: AgentLaunchSpec): ToolContext;
  /** DPI: assemble the worker's appended system-prompt text (the same fragments
   *  the CLI lane writes to --append-system-prompt-file). Absent/null → no append.
   *  Without it an SDK agent boots with only the stock claude_code prompt and never
   *  learns the Eos orchestration protocol — so it has the MCP tools but ignores them. */
  assembleAppendPrompt?(spec: AgentLaunchSpec): string | null;
  /** Resolve + translate the worker's inherited/external MCP servers (.mcp.json,
   *  ~/.claude.json) into the SDK union, MERGED with the in-process Eos builtins
   *  (builtins win on name collision). OMITTED on the judge backend → that session
   *  sees only its (empty) builtins, no inherited leak. Mirrors the optional
   *  assembleAppendPrompt dep — composition selects the lane, not a kind check. */
  resolveSdkMcpServers?(
    spec: AgentLaunchSpec,
    builtins: Record<string, McpServerConfig>,
  ): { mcpServers: Record<string, McpServerConfig>; dropped: DroppedServer[] };
  queryFn?: SdkQueryFn;
  /** Recall (Layer 2) transcript-slice primitive — defaults to the SDK's
   *  forkSession. Overridden in tests. */
  forkSessionFn?: ForkSessionFn;
  /** Reads a claude-transcript session JSONL for (cwd, sessionId) — the rewind
   *  panel's source. Defaults to the on-disk read under ~/.claude/projects;
   *  overridden in tests so getRewindTargets/rewind assert against scripted JSONL
   *  without touching disk (mirrors forkSessionFn). null = no transcript yet. */
  readTranscriptFn?: (cwd: string, sessionId: string) => string | null;
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
  // The CURRENT launch's abort controller (fresh per spawn/relaunch — an aborted
  // controller must never be reused). stop() aborts it so the in-flight turn
  // actually ends instead of running on as a ghost after the row is deleted.
  abort: AbortController;
  alive: boolean;
  // Set by interrupt() before q.interrupt(); guards the stream-completion branch
  // so an interrupt that ends the query iterator is reported as an interrupt
  // (143 + turn:aborted), never a spurious clean exit (code 0 → markDone).
  interrupting: boolean;
  onExit?: (code: number | null) => void;
  // /clear: tear down the current query and start a fresh one (new session, no
  // resume, empty context). The session row stays alive across the swap.
  relaunch?: () => void;
  // Recall (Layer 2): like relaunch() but RESUMES the given (forked, sliced)
  // session instead of starting empty.
  relaunchResume?: (resume: string) => void;
  // The current turn's mapper — surfaces sessionId + lastAssistantUuid (the
  // recall anchor). Re-created on every (re)launch.
  mapper?: SdkEventMapper;
  // The worker's cwd — the project dir forkSession scopes its transcript search to.
  cwd?: string;
}

export function createClaudeSdkBackend(deps: ClaudeSdkBackendDeps): AgentBackend {
  const queryFn: SdkQueryFn = deps.queryFn ?? ((p) => realQuery(p as never) as unknown as SdkQueryHandle);
  const forkSessionFn: ForkSessionFn = deps.forkSessionFn ?? ((sid, opts) => realForkSession(sid, opts));
  // The claude-transcript store lives at ~/.claude/projects/<encodeCwd(realpath
  // cwd)>/<sessionId>.jsonl — the same scheme the CLI-lane tail derives (spawner/
  // tail.ts). encodeCwd needs a realpath'd cwd; fall back to the raw cwd if it
  // can't be resolved. Missing file → null (no transcript yet).
  const readTranscriptFn: (cwd: string, sessionId: string) => string | null =
    deps.readTranscriptFn ?? ((cwd, sessionId) => {
      let dir = cwd;
      try { dir = realpathSync(cwd); } catch { /* keep the raw cwd */ }
      const path = join(homedir(), ".claude", "projects", encodeCwd(dir), `${sessionId}.jsonl`);
      try { return readFileSync(path, "utf8"); } catch { return null; }
    });
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
    // Recall (Layer 2): the user interrupted before the agent answered — roll the
    // SDK's own conversation back to BEFORE the recalled message so it leaks into
    // neither the next turn nor a resume. Sibling of clearContext (same relaunch +
    // teardown discipline): instead of starting empty, fork the transcript sliced
    // to the last assistant message (the anchor) and resume THAT. forkSession
    // writes a fresh session file with remapped uuids; the new session id is
    // captured by the relaunch's mapper and persisted, so a later resume is clean.
    async recallLastUserTurn() {
      const s = live.get(workerId);
      if (!s || !s.alive) return { ok: false, reason: "session gone" };
      const sessionId = s.mapper?.sessionId ?? null;
      if (!sessionId) return { ok: false, reason: "no session id captured yet" };
      const anchor = s.mapper?.lastAssistantUuid ?? null;
      const oldInput = s.input;
      const oldQ = s.q;
      // No anchor → the recalled message was the FIRST turn; nothing precedes it,
      // so relaunch empty (identical to /clear).
      if (anchor) {
        let forkedId: string;
        try {
          const forked = await forkSessionFn(sessionId, { ...(s.cwd ? { dir: s.cwd } : {}), upToMessageId: anchor });
          forkedId = forked.sessionId;
        } catch (e) {
          return { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
        s.relaunchResume?.(forkedId);
      } else {
        s.relaunch?.();
      }
      oldInput.close();
      if (oldQ?.interrupt) { try { await oldQ.interrupt(); } catch { /* best-effort */ } }
      return { ok: true };
    },
    // Rewind (the double-Esc panel / per-message undo): list the active-branch user
    // prompts from the live session's transcript so the UI can offer them.
    async getRewindTargets(): Promise<{ targets: RewindTarget[] }> {
      const s = live.get(workerId);
      const sessionId = s?.mapper?.sessionId ?? null;
      if (!s || !sessionId || !s.cwd) return { targets: [] };
      const jsonl = readTranscriptFn(s.cwd, sessionId);
      return { targets: jsonl ? computeRewindTargets(jsonl) : [] };
    },
    // Roll the SDK conversation back to a prior user prompt (and optionally its
    // code). Sibling of recallLastUserTurn — same fork + relaunch + teardown
    // discipline — generalized from "the last, unanswered turn" to any selected
    // prompt on the active branch.
    async rewind(uuid: string, mode: string): Promise<RewindResult> {
      const s = live.get(workerId);
      if (!s || !s.alive) return { ok: false, error: "session gone" };
      const sessionId = s.mapper?.sessionId ?? null;
      if (!sessionId) return { ok: false, error: "no session id captured yet" };
      const jsonl = s.cwd ? readTranscriptFn(s.cwd, sessionId) : null;
      if (!jsonl) return { ok: false, error: "no session transcript yet" };
      const targets = computeRewindTargets(jsonl);
      const index = targets.findIndex((t) => t.uuid === uuid);
      if (index < 0) return { ok: false, error: "message not found on the active branch" };
      const target = targets[index];

      // code/both: restore tracked files to their state at the selected message,
      // on the CURRENT live query (its checkpoints are keyed by the original
      // uuids — a fork below would remap them), so this runs FIRST. rewindFiles
      // needs file checkpointing; without it canRewind is false — code-only fails
      // honestly, both silently degrades to conversation-only (parity with the CLI
      // submenu, whose option 1 is conversation-only when no checkpoint exists).
      if (mode === "code" || mode === "both") {
        const q = s.q;
        if (mode === "code" && !q?.rewindFiles) return { ok: false, error: "file rewind unavailable on this session" };
        if (q?.rewindFiles) {
          const r = await q.rewindFiles(uuid).catch((e) => ({ canRewind: false, error: e instanceof Error ? e.message : String(e) }));
          if (mode === "code" && !r.canRewind) return { ok: false, error: r.error ?? "no code checkpoint exists for this message" };
        }
      }

      // conversation/both: fork the transcript sliced to the entry BEFORE the
      // selected prompt (rewindSliceAnchor = its parent; forkSession's
      // upToMessageId is inclusive, so slicing to the prompt itself would keep it)
      // and resume THAT. No predecessor (the first prompt) → relaunch fresh, like
      // /clear. The web chat prefills the composer with target.text.
      if (mode === "conversation" || mode === "both") {
        const anchor = rewindSliceAnchor(jsonl, uuid);
        const oldInput = s.input;
        const oldQ = s.q;
        if (anchor) {
          let forkedId: string;
          try {
            const forked = await forkSessionFn(sessionId, { ...(s.cwd ? { dir: s.cwd } : {}), upToMessageId: anchor });
            forkedId = forked.sessionId;
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
          s.relaunchResume?.(forkedId);
        } else {
          s.relaunch?.();
        }
        oldInput.close();
        if (oldQ?.interrupt) { try { await oldQ.interrupt(); } catch { /* best-effort */ } }
      }

      return { ok: true, uuid: target.uuid, text: target.text, display: target.display, index };
    },
    // Runtime model switch via the SDK Query control method (streaming-input
    // only). effort is ignored HERE — the SDK has no live /effort equivalent; it's
    // persisted by the caller and applied at start()/resume via Options.effort.
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
      // End the IN-FLIGHT turn, not just future input: interrupt is the graceful
      // path, abort the hard one (the SDK closes stdin, then kills the subprocess
      // after its ~2s grace window). Without these a stopped/deleted agent keeps
      // acting — and calling tools — until its current turn finishes on its own.
      if (s.q?.interrupt) { try { s.q.interrupt().catch(() => {}); } catch { /* best-effort */ } }
      s.abort.abort();
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
      const anthropic = deps.getAnthropicConfig?.() ?? {};
      const env = buildBillingGuardEnv({ auth, anthropic, workerId: spec.workerId, daemonUrl: deps.daemonUrl });
      const ctx = deps.makeToolContext(spec);
      // MCP servers are built PER LAUNCH, never shared across queries: the Eos
      // builtins are live McpServer instances (createSdkMcpServer), and the MCP
      // protocol allows ONE transport per instance — reusing an instance on a
      // /clear or recall relaunch makes the new query's connect throw "Already
      // connected", which the SDK swallows silently, so the agent loses every
      // Eos tool. Fresh instances per spawn() also pick up inherited .mcp.json
      // edits on a relaunch. allowedTools stays EMPTY (from SdkToolHost): an
      // allow-listed tool bypasses canUseTool; keeping Eos tools out routes EVERY
      // call through canUseTool → PolicyGatewayService, like the PTY hook-as-gateway.
      const buildMcpServers = (): { mcpServers: Record<string, McpServerConfig>; allowedTools: string[] } => {
        const built = buildSdkToolServers(deps.toolHost, {
          isOrchestrator: spec.isOrchestrator,
          collaborate: backendCollaborate(opts),
          role: backendRole(opts),
          ctx,
        });
        // Default: just the in-process Eos builtins (judge / no resolver). With the
        // resolver wired (worker/orchestrator lane) the inherited + external servers
        // are merged in, Eos builtins winning collisions; dropped entries are logged.
        if (!deps.resolveSdkMcpServers) return built;
        const r = deps.resolveSdkMcpServers(spec, built.mcpServers);
        if (r.dropped.length) {
          deps.log?.warn("dropped inherited MCP servers", { workerId: spec.workerId, dropped: r.dropped });
        }
        return { mcpServers: r.mcpServers, allowedTools: built.allowedTools };
      };

      // The Eos orchestration protocol + injected project/user memory (CLAUDE.md,
      // …) ride in the appended system prompt. The container assembles both into
      // this text (assembleAppendFor → DPI + selectInjectableMemory); settingSources:[]
      // below drops the binary's own memory auto-load, so this is the SDK lane's
      // only memory channel.
      const append = deps.assembleAppendPrompt?.(spec) ?? null;

      // Options shared by the initial launch AND any /clear restart. `resume` is
      // added per-launch — the initial honors backendOptions.resume; a clear
      // restart never resumes (fresh session, empty context). mcpServers +
      // allowedTools are ALSO per-launch (fresh instances via buildMcpServers).
      const baseOptions = {
        model: spec.model,
        // Run the SDK session in the worker's resolved directory (plain cwd, or
        // the materialized worktree). Without this the SDK defaults to the
        // daemon's process.cwd() and the agent reads/edits the wrong tree.
        ...(spec.cwd ? { cwd: spec.cwd } : {}),
        env,
        // Hard-remove AskUserQuestion regardless of permission mode (it has no answer
        // surface in Eos; redirect to mcp__orchestrator__ask_user) — platform-wide deny.
        // Orchestrators additionally lose Task (they dispatch via spawn_worker, not
        // internal subagents); workers keep it. Keyed on the immutable isOrchestrator fact.
        disallowedTools: disallowedBuiltinToolsFor(spec.isOrchestrator),
        canUseTool: makeCanUseTool(spec.workerId, deps.policy),
        includePartialMessages: true,
        // Load the user/project filesystem sources so the binary discovers skills
        // (and agents/commands/CLAUDE.md) natively, exactly like the CLI lane —
        // settingSources:[] suppressed that and broke user/project skills. MCP is
        // still isolated independently by strictMcpConfig below (the explicit
        // resolveSdkMcpServers set wins; ambient .mcp.json never leaks in).
        settingSources: ["user", "project"] as Options["settingSources"],
        // Permission allow/ask/deny rules from those settings.json files must NOT
        // pre-approve a tool ahead of the Eos gateway: canUseTool only fires on the
        // prompt path, so a settings `allow` rule would bypass it. Restricting
        // permission rules to the (empty) managed tier neutralizes that — every
        // call still routes through canUseTool → PolicyGatewayService.
        managedSettings: { allowManagedPermissionRulesOnly: true } as Options["managedSettings"],
        strictMcpConfig: true,
        // display:"summarized" is required to stream thinking on Opus 4.7+ (it
        // otherwise defaults to omitted) — proven by the spike.
        thinking: (opts.thinking as Options["thinking"]) ?? ({ type: "adaptive", display: "summarized" } as Options["thinking"]),
        // effort maps 1:1 to the CLI `--effort` enum, already normalized by SpawnWorker.
        ...(spec.effort ? { effort: spec.effort as Options["effort"] } : {}),
        ...(append ? { systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append } } : {}),
        // bypassPermissions requires the explicit safety flag; else pass the mode through.
        ...(spec.permissionMode === "bypassPermissions"
              ? { permissionMode: "bypassPermissions" as const, allowDangerouslySkipPermissions: true }
              : spec.permissionMode ? { permissionMode: spec.permissionMode as Options["permissionMode"] } : {}),
      } as Options;

      const rec: Live = { q: null, input: createPushStream(), abort: new AbortController(), alive: true, interrupting: false, onExit: cb?.onExit, ...(spec.cwd ? { cwd: spec.cwd } : {}) };
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
        // Fresh controller per launch — /clear and recall relaunches must not
        // inherit a (possibly aborted) predecessor. stop() aborts the current one.
        const abort = new AbortController();
        rec.abort = abort;
        const { mcpServers, allowedTools } = buildMcpServers();
        const options = { ...baseOptions, mcpServers, allowedTools, abortController: abort, ...(resume ? { resume } : {}) } as Options;
        const mapper = createSdkEventMapper();
        rec.mapper = mapper;
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
              for (const e of mapper.map(msg as SdkMsg)) {
                // The SDK has no dedicated "interrupted" result subtype — a
                // user-requested interrupt ends the turn with subtype
                // "error_during_execution", which the mapper (unaware of the
                // interrupt) surfaces as turn:error. Recognize that ONLY while
                // WE set rec.interrupting, and translate to turn:aborted — the
                // same convention as the m1 precedent in ToolRuntime. Other
                // error_* subtypes (error_max_turns, or error_during_execution
                // with no interrupt in flight) must keep flowing as turn:error.
                if (rec.interrupting && e.type === "turn" && e.phase === "error" && e.reason === "error_during_execution") {
                  rec.interrupting = false;
                  cb?.onEvent?.({ type: "turn", phase: "aborted", reason: "interrupted" });
                  continue;
                }
                cb?.onEvent?.(e);
              }
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
            // !rec.alive here means stop() already tore the session down — the
            // abort's own error is expected, not a crash worth logging.
            if (rec.alive) {
              deps.log?.warn("claude-sdk query failed", { workerId: spec.workerId, error: e instanceof Error ? e.message : String(e) });
              rec.alive = false;
              live.delete(spec.workerId);
              // onExit BEFORE the ended event: the exit handler reads the row
              // state to suspend a resumable session, and the ended event would
              // flip it to ENDING first — a state SUSPENDED is unreachable from.
              // The crash still logs as an agent_event; its late ENDING attempt
              // is rejected against SUSPENDED, which is exactly the intent.
              cb?.onExit?.(1);
              cb?.onEvent?.({ type: "session", phase: "ended", outcome: "crashed" });
            }
          }
        })();
      };

      rec.relaunch = () => spawn(undefined, undefined);
      rec.relaunchResume = (resume: string) => spawn(resume, undefined);
      spawn(typeof opts.resume === "string" ? opts.resume : undefined, spec.prompt || undefined);

      return session(spec.workerId);
    },
    attach(workerId: string): AgentSession {
      return session(workerId);
    },
  };
}
