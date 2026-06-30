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

export interface InProcessEnvFactoryDeps {
  // B1: the complete in-process DPI system prompt for this spawn (null ⇒ none).
  assembleSystem(spec: AgentLaunchSpec): string | null;
  buildLaneTooling(spec: AgentLaunchSpec): { items: LaneToolItem[]; tools: Map<string, RuntimeTool> };
  authResolver: AuthResolver;
  makeGate(workerId: string): ToolGate;
  // Dialect-specific model-client builder bound at construction (Anthropic vs
  // OpenAI) — selection is by which factory the registry wires, never a kind branch.
  buildModelClient(input: InProcessModelClientInput): ModelClient;
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
    return { model, tools, gate: deps.makeGate(spec.workerId), contextWindow: capabilities?.contextWindow };
  };
}
