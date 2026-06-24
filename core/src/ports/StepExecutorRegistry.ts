// StepExecutorRegistry — the Registry/Factory (§3.11), the Open/Closed seam.
// `type → executor`, populated explicitly at the composition root (no reflection,
// clone of makeStrategyFor / AgentBackendRegistry). `get` throws a clear error on
// an unknown type so a malformed spec fails loud rather than silently no-oping.
// The pure impl is InMemoryStepExecutorRegistry in core/src/workflow/.

import type { StepExecutor } from "./StepExecutor.ts";

export interface StepExecutorRegistry {
  register(exec: StepExecutor): void;   // composition-root only — explicit, not reflection
  get(type: string): StepExecutor;      // throws on unknown type (clear error)
  has(type: string): boolean;
  types(): string[];
}
