// MicroTask — pure contracts for the daemon-side micro-task subsystem: small,
// predetermined-prompt LLM tasks triggered off the EventBus (auto-naming is the
// first instance). No Node imports — the runner (manager/services) wires these
// to the bus, the one-shot LLM client, config, and the prompt service.

import type { EventBusTopic } from "./EventBus.ts";

// What fires a task and how to find its subject. match() inspects a raw bus
// payload and returns the entity id the task should act on, or null to ignore.
export interface MicroTaskTrigger {
  readonly topic: EventBusTopic;
  match(payload: unknown): string | null;
}

// Per-run inputs handed to a task's hooks. `now` is clock.now() at the moment
// the hook runs (extract/apply see the fire time; gate sees its own call time).
export interface MicroTaskContext {
  readonly entityId: string;
  readonly now: number;
}

// One micro-task as a four-step pipeline: trigger → gate → extract → apply.
// gate is a cheap precondition re-checked just before firing; extract returns
// the prompt variables (or null to abort); apply consumes the LLM output.
export interface MicroTask {
  readonly id: string;
  readonly trigger: MicroTaskTrigger;
  readonly promptId: string;
  gate(ctx: MicroTaskContext): boolean | Promise<boolean>;
  extract(ctx: MicroTaskContext): Promise<Record<string, string> | null>;
  apply(ctx: MicroTaskContext, output: string): Promise<void>;
}
