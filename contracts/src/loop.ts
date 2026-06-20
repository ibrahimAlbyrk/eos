// Dynamic-loop contracts — the structured goal a loop drives toward, the loop's
// lifecycle status, the judge verdict (consumed in a later phase), and the
// orchestrator-only attach/stop request shape. Single source of truth for every
// loop IPC payload, mirrored by the core LoopStateRepo port + the loops route.

import { z } from "zod";

// Loop lifecycle. "active" is the only non-terminal state; a loop leaves it once
// its goal is met ("passed"), its attempt limit is hit ("exhausted"), or the
// orchestrator stops it ("stopped"). The allowed moves live in
// core/domain/loop-status.ts.
export const LoopStatusSchema = z.enum(["active", "passed", "exhausted", "stopped"]);
export type LoopStatus = z.infer<typeof LoopStatusSchema>;

// How the goal is checked each tick: a deterministic shell command, an LLM
// judge, or both (hybrid). Consumed by the goal-check strategy in a later phase.
export const LoopStrategySchema = z.enum(["command", "judge", "hybrid"]);
export type LoopStrategy = z.infer<typeof LoopStrategySchema>;

// The structured target a looped agent works toward. `summary` is the human
// headline; each criterion is independently checkable, and `verify` (optional)
// is the deterministic command that proves it for the "command"/"hybrid"
// strategies.
export const GoalSpecSchema = z.object({
  summary: z.string(),
  criteria: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        verify: z.string().optional(),
      }),
    )
    .min(1),
});
export type GoalSpec = z.infer<typeof GoalSpecSchema>;

// The result of a goal check (produced by the judge/command strategy in P3).
// `met` is the overall verdict; `criteria` carries the per-criterion outcome +
// evidence; `unmet` lists the ids still failing; `confidence` ∈ [0,1].
export const GoalVerdictSchema = z.object({
  met: z.boolean(),
  criteria: z.array(
    z.object({
      id: z.string(),
      met: z.boolean(),
      evidence: z.string(),
    }),
  ),
  unmet: z.array(z.string()),
  confidence: z.number(),
  reason: z.string(),
});
export type GoalVerdict = z.infer<typeof GoalVerdictSchema>;

// Orchestrator-only request driving the `dynamic_loop` tool. `op` selects
// attach vs stop. For attach: `goal` is required, `target` omitted/equal to the
// caller means a self-loop, `strategy` defaults to "hybrid", and `limit` is the
// attempt bound (null = unbounded — the only user-facing bound besides
// goal-met). For stop: `loopId` (or `target`) identifies the loop to stop.
export const DynamicLoopRequestSchema = z.object({
  op: z.enum(["attach", "stop"]),
  target: z.string().optional(),
  goal: GoalSpecSchema.optional(),
  strategy: LoopStrategySchema.optional(),
  limit: z.number().int().positive().nullable().optional(),
  loopId: z.string().optional(),
});
export type DynamicLoopRequest = z.infer<typeof DynamicLoopRequestSchema>;

export const DynamicLoopResponseSchema = z.object({
  loopId: z.string(),
  status: LoopStatusSchema,
});
export type DynamicLoopResponse = z.infer<typeof DynamicLoopResponseSchema>;

// Arm-at-spawn: the loop a worker is born with (spawn_worker's `loop`). The loop
// is attached BEFORE the worker's first turn, so it precedes every IDLE edge
// (no dormant-loop race) and holds the very first report (R7). strategy/limit
// default from config.loop when omitted.
export const SpawnLoopSchema = z.object({
  goal: GoalSpecSchema,
  strategy: LoopStrategySchema.optional(),
  limit: z.number().int().positive().nullable().optional(),
});
export type SpawnLoop = z.infer<typeof SpawnLoopSchema>;
