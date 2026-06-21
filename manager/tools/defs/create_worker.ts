import { z } from "zod";
import { EFFORT_LEVELS } from "../../../contracts/src/shared.ts";
import type { ToolDefinition } from "../types.ts";

export const createWorkerDef: ToolDefinition = {
  name: "create_worker",
  visibility: "orchestrator",
  inputSchema: {
    name: z.string().describe("Identity, kebab-case (e.g. 'perf-profiler')."),
    description: z.string().optional().describe("Human-facing label for this worker."),
    whenToUse: z.string().optional().describe("Routing signal: when should a task be dispatched to this worker."),
    model: z.string().optional().describe("Default model (opus/sonnet/haiku). Omit ⇒ inherit."),
    effort: z.enum(EFFORT_LEVELS).optional().describe("Default reasoning effort. Omit ⇒ inherit."),
    permissionMode: z.enum(["acceptEdits", "bypassPermissions"]).optional().describe("Default permission mode."),
    persistent: z.boolean().optional().describe("Stay alive after a turn (conversational session)."),
    collaborate: z.boolean().optional().describe("Default the peer-mesh opt-in."),
    toolsAllow: z.array(z.string()).optional().describe("Tool allowlist (globs, e.g. 'Read', 'mcp__*'). Empty/omit ⇒ inherit all tools."),
    toolsDeny: z.array(z.string()).optional().describe("Tool denylist (globs). Always subtracts, even from an allowlist."),
    editRegex: z.string().optional().describe("Restrict file edits to paths matching this regex (e.g. 'src/.*\\\\.ts$')."),
    extends: z.string().optional().describe("Base worker name to inherit unset fields from."),
    body: z.string().describe("This worker's role instructions — its durable system-prompt body. Task-specific only: environment map, cached facts, output contract, if-then failure rules. Do NOT restate the result:/needs input:/failed: signal protocol, report structure, or Handover (the worker contract already supplies those). See create_worker's full guidance."),
  },
  // Validate + store a runtime worker definition for THIS orchestrator (per-owner,
  // in-memory). Defining does NOT start anything — run it with
  // spawn_worker({ from: <name>, ... }). Returns { name }.
  handler: async (ctx, args) => ctx.api("POST", `/worker-definitions?owner=${encodeURIComponent(ctx.selfId)}`, args),
};
