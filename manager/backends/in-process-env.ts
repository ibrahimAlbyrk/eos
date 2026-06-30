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
import type { RuntimeTool, ToolGate } from "../../core/src/use-cases/ToolRuntime.ts";
import type { ProviderCapabilities } from "../../contracts/src/provider-capabilities.ts";

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
  // The Task subagent closure (§5e). Optional: tests/conformance omit it (no Task).
  // The Task model-schema item is added to the surface by buildLaneTooling (sync);
  // its executor — which needs resolved creds + the session emit/signal — is bound
  // here. Orchestrators never get it (Task is stripped from their surface).
  makeSubagentTool?(rt: SubagentRuntimeContext): RuntimeTool;
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
    const model = deps.buildModelClient({
      apiKey: creds.apiKey ?? "",
      baseUrl: opts?.baseUrl ?? creds.baseUrl,
      model: spec.model,
      system,
      items,
      capabilities,
    });
    const env: InProcessEnv = { model, tools, gate: deps.makeGate(spec.workerId), contextWindow: capabilities?.contextWindow };
    // Bind the Task subagent executor once the session's emit/signal exist. The
    // matching schema item is already in `items` (buildLaneTooling), so the model
    // sees Task; orchestrators get neither (Task stripped from their surface).
    if (deps.makeSubagentTool && !spec.isOrchestrator) {
      env.bindSession = ({ emit, signal }) => {
        const task = deps.makeSubagentTool!({
          parentSpec: spec,
          apiKey: creds.apiKey ?? "",
          baseUrl: opts?.baseUrl ?? creds.baseUrl,
          capabilities,
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
