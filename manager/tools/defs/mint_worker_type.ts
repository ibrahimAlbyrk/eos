import { z } from "zod";
import { EFFORT_LEVELS } from "../../../contracts/src/shared.ts";
import type { ToolDefinition } from "../types.ts";

export const mintWorkerTypeDef: ToolDefinition = {
  name: "mint_worker_type",
  visibility: "orchestrator",
  inputSchema: {
    name: z.string().describe("Identity, kebab-case (e.g. 'perf-profiler'). Spawn with this via workerType."),
    description: z.string().optional().describe("Human-facing label for the type."),
    whenToUse: z.string().optional().describe("Routing signal: when should a task be dispatched to this type."),
    model: z.string().optional().describe("Default model (opus/sonnet/haiku/fable). Omit ⇒ inherit."),
    effort: z.enum(EFFORT_LEVELS).optional().describe("Default reasoning effort. Omit ⇒ inherit."),
    permissionMode: z.enum(["acceptEdits", "bypassPermissions"]).optional().describe("Default permission mode."),
    persistent: z.boolean().optional().describe("Stay alive after a turn (conversational session)."),
    collaborate: z.boolean().optional().describe("Default the peer-mesh opt-in."),
    toolsAllow: z.array(z.string()).optional().describe("Tool allowlist (globs, e.g. 'Read', 'mcp__*'). Empty/omit ⇒ inherit all tools."),
    toolsDeny: z.array(z.string()).optional().describe("Tool denylist (globs). Always subtracts, even from an allowlist."),
    editRegex: z.string().optional().describe("Restrict file edits to paths matching this regex (e.g. 'src/.*\\\\.ts$')."),
    extends: z.string().optional().describe("Base type name to inherit unset fields from."),
    body: z.string().describe("The type's instructions (the worker's role body). Author to good prompt design: environment map, output contract, if-then failure rules."),
  },
  // Validate + store a runtime type for THIS orchestrator (per-owner, in-memory).
  // Then spawn it with spawn_worker({ workerType: <name>, ... }). Returns { name }.
  handler: async (ctx, args) => ctx.api("POST", `/worker-types?owner=${encodeURIComponent(ctx.selfId)}`, args),
};
