// createInProcessEnvFactory — the in-process (metered API) lane's env factory,
// extracted from the container so it is unit-testable (DIP). It composes the four
// per-session ingredients the ToolRuntime needs:
//   1. system — the COMPLETE DPI system prompt (B1): assembleAppendFor(spec, id,
//      "in-process"). This is the ONLY instruction channel on this lane (no binary
//      preset behind it), so it carries role framing + the Eos reporting/orchestration
//      protocol + the worker-definition body + injected memory + the lane base harness.
//   2. tools — the lane tool surface (control tools today; built-ins land in M2).
//   3. gate  — the shared policy gate (fail-closed via ToolRuntime.executeGated).
//   4. model — built from RESOLVED credentials (AuthResolver.resolve at start(),
//      never process.env), against the per-worker baseUrl. The dialect-specific
//      client builder is injected at construction, so there is NO backend-kind branch.
//
// The factory is async ONLY because credential resolution is async (the design
// invariant); buildLaneTooling stays sync.

import type { AgentLaunchSpec } from "../../core/src/ports/AgentBackend.ts";
import type { AgentEvent } from "../../contracts/src/canonical.ts";
import type { InProcessEnv, InProcessEnvFactory } from "../../infra/src/backends/InProcessBackend.ts";
import type { AuthResolver } from "../../core/src/ports/AuthResolver.ts";
import type { ModelClient } from "../../core/src/ports/ModelClient.ts";
import type { ContextCompactor } from "../../core/src/ports/ContextCompactor.ts";
import type { RuntimeTool, ToolGate } from "../../core/src/use-cases/ToolRuntime.ts";
import type { ProviderCapabilities } from "../../contracts/src/provider-capabilities.ts";
import type { ProviderErrorInfo } from "../../infra/src/backends/provider-error.ts";
import type { RuntimeMcpToolset } from "./runtime-mcp.ts";

// The model-schema view of one lane tool (name + provider-neutral JSON schema).
export interface LaneToolItem {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface InProcessModelClientInput {
  apiKey: string;
  baseUrl?: string;
  model: string;
  system?: string;
  items: LaneToolItem[];
  capabilities?: ProviderCapabilities;
  // M4 — per-worker model params (temperature/max_tokens/thinking) + the normalized
  // effort, applied by the dialect client per capabilities. workerId is threaded for
  // the provider-error structured log (m5).
  params?: Record<string, unknown>;
  effort?: string | null;
  workerId?: string;
  onProviderError?(e: ProviderErrorInfo): void;
}

// The per-session runtime ingredients the Task (subagent) closure captures. It is
// built HERE, after credential resolution (N2: resolved creds + the dialect builder,
// never process.env), and bound the session's emit/signal at start() time (they do
// not exist at factory time). The closure runs a nested ToolRuntime for the child.
export interface SubagentRuntimeContext {
  parentSpec: AgentLaunchSpec;
  apiKey: string;
  baseUrl?: string;
  capabilities?: ProviderCapabilities;
  // M4 — parent params/effort + the compactor flow to the child loop (same provider).
  params?: Record<string, unknown>;
  effort?: string | null;
  compactor?: ContextCompactor;
  // M5 — the session's external-MCP tools. These are the SAME LIVE refs the factory
  // fills when its BACKGROUND connect resolves (initially empty), so a subagent that
  // runs after the connect still sees mcp__<server>__<tool> (the closure reads them
  // at Task-execute time). The child shares the parent's connections (session-scoped,
  // closed once at stop) — gated mcp-always-allow, and NOT a control tool, so
  // rung-0.5 subagent isolation leaves them callable.
  mcpItems?: LaneToolItem[];
  mcpTools?: Map<string, RuntimeTool>;
  depth: number;
  emit(e: AgentEvent): void;
  signal: { aborted: boolean };
  buildModelClient(input: InProcessModelClientInput): ModelClient;
}

export interface InProcessEnvFactoryDeps {
  // B1: the complete in-process DPI system prompt for this spawn (null ⇒ none).
  assembleSystem(spec: AgentLaunchSpec): string | null;
  buildLaneTooling(spec: AgentLaunchSpec): { items: LaneToolItem[]; tools: Map<string, RuntimeTool> };
  authResolver: AuthResolver;
  makeGate(workerId: string): ToolGate;
  // Dialect-specific model-client builder bound at construction (Anthropic vs
  // OpenAI) — selection is by which factory the registry wires, never a kind branch.
  buildModelClient(input: InProcessModelClientInput): ModelClient;
  // M4 — the ContextCompactor, threaded into the loop so a near-window conversation
  // is trimmed (turn continues) instead of a raw provider 400. Optional (tests omit).
  compactor?: ContextCompactor;
  // M5 — external-MCP tool resolution (§5c). Connects each configured server,
  // lists + wraps its tools as mcp__<server>__<tool> RuntimeTools, fail-soft on a
  // dead server. Async (it opens connections); the factory runs it in the BACKGROUND
  // (NOT awaited) so a slow/auth-failing server can't gate session start. Optional:
  // tests/conformance omit it (no external MCP). Its close() tears the connections
  // down at session stop (wired onto env.closeSession).
  resolveMcpTools?(spec: AgentLaunchSpec): Promise<RuntimeMcpToolset>;
  // The Task subagent closure (§5e). Optional: tests/conformance omit it (no Task).
  // The Task model-schema item is added to the surface by buildLaneTooling (sync);
  // its executor — which needs resolved creds + the session emit/signal — is bound
  // here. Orchestrators never get it (Task is stripped from their surface).
  makeSubagentTool?(rt: SubagentRuntimeContext): RuntimeTool;
  // M6 — the bare name of the Skill RuntimeTool on the surface (§5c), threaded to the
  // loop so a loaded skill body also surfaces as a canonical skill block. Absent ⇒ no
  // skill-block emit (tests). The Skill tool itself is merged by buildLaneTooling.
  skillToolName?: string;
  // MJ2 — kill + evict this session's background (run_in_background) shells when the
  // session stops, so a worker kill doesn't orphan detached children. Composed onto
  // env.closeSession alongside the MCP teardown. Optional (tests/conformance omit it).
  reapShells?(workerId: string): void;
}

export function createInProcessEnvFactory(deps: InProcessEnvFactoryDeps): InProcessEnvFactory {
  return async (spec: AgentLaunchSpec): Promise<InProcessEnv> => {
    const opts = spec.backendOptions;
    // Resolve credentials BY REFERENCE at launch (keychain/env/none) — never read
    // a global process.env key, so "any provider per worker" is expressible.
    const creds = await deps.authResolver.resolve(opts?.auth);
    const { items, tools } = deps.buildLaneTooling(spec);
    const system = deps.assembleSystem(spec) ?? undefined;
    const capabilities = opts?.capabilities;
    const params = opts?.params as Record<string, unknown> | undefined;
    // Build a model client over the CURRENT tool surface. Called once now (built-ins +
    // control) so the session is ready immediately, and again when the background MCP
    // connect resolves (built-ins + MCP) — each dialect client SNAPSHOTS its tool
    // schema at construction, so pushing items into the array afterwards would never
    // reach the model; the client must be rebuilt and env.model swapped.
    const buildModel = (toolItems: LaneToolItem[]): ModelClient =>
      deps.buildModelClient({
        apiKey: creds.apiKey ?? "",
        baseUrl: opts?.baseUrl ?? creds.baseUrl,
        model: spec.model,
        system,
        items: toolItems,
        capabilities,
        params,
        effort: spec.effort,
        workerId: spec.workerId,
      });
    const env: InProcessEnv = { model: buildModel(items), tools, gate: deps.makeGate(spec.workerId), contextWindow: capabilities?.contextWindow, capabilities, compactor: deps.compactor, skillToolName: deps.skillToolName };

    // M5 perf — connect external MCP in the BACKGROUND (§5c). The in-process lane has
    // no binary to background MCP for it, so awaiting the connect here is felt directly
    // as session-start lag (the slowest/auth-failing server gates the first paint).
    // Return the env with built-ins now; when the connect lands, merge its tools into
    // the live surface AND swap env.model so the model sees them on the NEXT turn
    // (kickTurn re-reads s.env.model each turn). The first turn essentially never needs
    // external MCP. mcpItems/mcpTools are the SAME live refs handed to the Task subagent
    // below — filled here so a subagent that runs after the connect still gets them.
    const mcpItems: LaneToolItem[] = [];
    const mcpTools = new Map<string, RuntimeTool>();
    let mcpToolset: RuntimeMcpToolset | undefined;
    let stopped = false;
    if (deps.resolveMcpTools) {
      env.whenMcpReady = (async () => {
        try {
          const mcp = await deps.resolveMcpTools!(spec);
          // The session may have stopped while connecting — close instead of leaking;
          // closeSession's pending-connect path relies on this teardown.
          if (stopped) { await mcp.close().catch(() => {}); return; }
          mcpToolset = mcp;
          for (const it of mcp.items) mcpItems.push(it);
          for (const [name, tool] of mcp.tools) mcpTools.set(name, tool);
          items.push(...mcp.items);
          for (const [name, tool] of mcp.tools) tools.set(name, tool);
          env.model = buildModel(items);
        } catch {
          // Fail-soft: a connect/list failure leaves the session on built-ins only.
        }
      })();
    }

    // Tear down session-scoped resources when the session stops (§5c lifecycle): this
    // session's background shells (MJ2) AND the external-MCP connections. This never
    // blocks on a still-connecting server — a pending connect closes itself on resolve
    // (it observes `stopped`), so a hung handshake can't stall stop().
    if (deps.resolveMcpTools || deps.reapShells) {
      env.closeSession = () => {
        deps.reapShells?.(spec.workerId);
        stopped = true;
        return mcpToolset?.close();
      };
    }
    // Bind the Task subagent executor once the session's emit/signal exist. The
    // matching schema item is already in `items` (buildLaneTooling), so the model
    // sees Task; orchestrators get neither (Task stripped from their surface). The
    // child shares the parent's LIVE MCP refs — initially empty, populated when the
    // background connect resolves (read at Task-execute time).
    if (deps.makeSubagentTool && !spec.isOrchestrator) {
      env.bindSession = ({ emit, signal }) => {
        const task = deps.makeSubagentTool!({
          parentSpec: spec,
          apiKey: creds.apiKey ?? "",
          baseUrl: opts?.baseUrl ?? creds.baseUrl,
          capabilities,
          params,
          effort: spec.effort,
          compactor: deps.compactor,
          mcpItems,
          mcpTools,
          depth: 0,
          emit,
          signal,
          buildModelClient: deps.buildModelClient,
        });
        tools.set(task.name, task);
      };
    }
    return env;
  };
}
