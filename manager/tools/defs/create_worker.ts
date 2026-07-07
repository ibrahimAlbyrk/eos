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
    model: z.string().optional().describe("Default model power tier — one of the tiers the active provider defines (listed in your §Model table), mapped to that provider's own models. Also accepts a concrete model id or 'provider/model' sugar. Omit ⇒ inherit."),
    effort: z.enum(EFFORT_LEVELS).optional().describe("Default reasoning effort. Honored only when the active provider exposes an effort lever; ignored otherwise. Omit ⇒ inherit."),
    permissionMode: z.enum(["acceptEdits", "bypassPermissions"]).optional().describe("Default permission mode."),
    persistent: z.boolean().optional().describe("Stay alive after a turn (conversational session)."),
    collaborate: z.boolean().optional().describe("Default the peer-mesh opt-in."),
    toolsAllow: z.array(z.string()).optional().describe("Tool allowlist (globs, e.g. 'Read', 'mcp__*'). Empty/omit ⇒ inherit all tools."),
    toolsDeny: z.array(z.string()).optional().describe("Tool denylist (globs). Always subtracts, even from an allowlist."),
    editRegex: z.string().optional().describe("Restrict file edits to paths matching this regex (e.g. '(^|/)src/.*\\\\.ts$'). Claude Code passes ABSOLUTE file paths, so anchor with `(^|/)path`, not `^path` (a `^`-anchored relative pattern never matches)."),
    extends: z.string().optional().describe("Base worker name to inherit unset fields from."),
    body: z.string().describe("This worker's role-instructions body (string). What to put in it / what NOT to (never restate the signal protocol / report / Handover) → create_worker's description and §Available workers."),
  },
  // Validate + store a runtime worker definition for THIS orchestrator (per-owner,
  // in-memory). Defining does NOT start anything — run it with
  // spawn_worker({ from: <name>, ... }). Returns { name }.
  handler: async (ctx, args) => ctx.api("POST", `/worker-definitions?owner=${encodeURIComponent(ctx.selfId)}`, args),
};
