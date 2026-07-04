import { z } from "zod";
import { EFFORT_LEVELS } from "../../../contracts/src/shared.ts";
import type { ToolDefinition } from "../types.ts";
import { commandRequest } from "../../../contracts/src/commands/types.ts";
import { spawnWorkerCommand } from "../../../contracts/src/commands/defs.ts";
import type { SpawnWorkerRequest, SpawnWorkerResponse } from "../../../contracts/src/http.ts";

export const spawnWorkerDef: ToolDefinition = {
  name: "spawn_worker",
  visibility: "orchestrator",
  inputSchema: {
    prompt: z.string().describe(
      "The worker's first user-turn (string). Follow the worker-prompt template in your system prompt (§Worker prompts: directive · Context · Acceptance · Out of scope · Report).",
    ),
    name: z.string().optional().describe(
      "Friendly slug for the worker (kebab-case). Should describe the outcome, not the action. Good: 'refactor-auth-tokens', 'add-billing-tests'. Bad: 'worker-1', 'fix-stuff', 'task'.",
    ),
    model: z.string().optional().describe(
      "Model power tier: 'high' | 'medium' | 'low', mapped to the active provider's models. Also accepts a concrete model id or 'provider/model' sugar (e.g. 'deepseek/deepseek-v4-pro' — sugar for backendProfile=<provider> + model=<rest>, the prefix split off before the API). A bare cross-provider model MUST use the combined form, or it will be rejected. Omit ⇒ the provider's default tier.",
    ),
    effort: z.enum(EFFORT_LEVELS).optional().describe(
      "Reasoning effort. Honored only when the active provider exposes an effort lever; ignored otherwise. Which level fits which work → §Model. Omit ⇒ default.",
    ),
    workspaceOf: z.string().optional().describe(
      "Spawn this worker INSIDE an existing worker's isolated worktree instead of a fresh one, for direct file access (to review, continue, or fix that worker's work). Pass the id of a worker you spawned (attaching to another orchestrator's worker is rejected). Only allowed while that worker is idle (fails with a conflict while it is busy).",
    ),
    collaborate: z.boolean().optional().describe(
      "Give this worker the peer tools (list_peers / ask_peer / respond_to_peer) so it can consult — and be consulted by — the other collaborate workers you spawn under you (its siblings). Omit ⇒ off.",
    ),
    from: z.string().optional().describe(
      "Available worker (definition) to spawn from. It pre-fills this worker's defaults (model, effort, permission mode, persistence) and frames its instructions — fields you pass explicitly still win. Omit ⇒ defaults to the general-purpose worker.",
    ),
    toolsAllow: z.array(z.string()).optional().describe(
      "Fence THIS worker's tools for a one-off (globs, e.g. 'Read', 'mcp__*'). Allowlist is exhaustive: anything not listed is denied. Empty/omit ⇒ inherit all tools. Wins over a `from` definition's allowlist.",
    ),
    toolsDeny: z.array(z.string()).optional().describe(
      "Subtract tools from THIS one-off worker (globs). Always subtracts, even from an allowlist. Wins over a `from` definition's denylist.",
    ),
    editRegex: z.string().optional().describe(
      "Confine THIS one-off worker's file edits to paths matching this regex (e.g. '(^|/)src/.*\\\\.ts$'). Claude Code passes ABSOLUTE file paths, so anchor with `(^|/)path`, not `^path` (a `^`-anchored relative pattern never matches). Enforced at the gate. Wins over a `from` definition's editRegex.",
    ),
    loop: z.object({
      goal: z.object({
        summary: z.string().describe("One-line definition of done."),
        criteria: z.array(z.object({
          id: z.string().describe("Stable short id for this criterion."),
          text: z.string().describe("The checkable condition in plain language."),
          verify: z.string().optional().describe("Deterministic shell command that proves it, if any."),
        })).min(1),
      }),
      strategy: z.enum(["command", "judge", "hybrid"]).optional(),
      limit: z.number().int().positive().nullable().optional(),
    }).optional().describe(
      "Arm a dynamic loop on this worker AT SPAWN so it can't finish until the goal is provably met. strategy: command / judge / hybrid (default hybrid). limit: a positive number caps attempts; omit or null = unbounded.",
    ),
  },
  handler: async (ctx, args) => {
    const { prompt, name, model, effort, workspaceOf, collaborate, from, toolsAllow, toolsDeny, editRegex, loop } = args as {
      prompt: string; name?: string; model?: string; effort?: string; workspaceOf?: string; collaborate?: boolean; from?: string;
      toolsAllow?: string[]; toolsDeny?: string[]; editRegex?: string; loop?: SpawnWorkerRequest["loop"];
    };
    const data: SpawnWorkerRequest = {
      prompt, name, model,
      withGateway: true,
      parentId: ctx.selfId,
    };
    if (effort) data.effort = effort;
    if (collaborate) data.collaborate = true;
    if (from) data.from = from;
    if (toolsAllow) data.toolsAllow = toolsAllow;
    if (toolsDeny) data.toolsDeny = toolsDeny;
    if (editRegex) data.editRegex = editRegex;
    if (loop) data.loop = loop;
    if (workspaceOf) data.workspaceOf = workspaceOf;
    else if (ctx.isGitRepo()) data.worktreeFrom = ctx.cwd;
    else data.cwd = ctx.cwd;
    const req = commandRequest(spawnWorkerCommand, {}, data);
    const res = (await ctx.api(req.method, req.path, req.body)) as SpawnWorkerResponse;
    return { id: res.id, isolation: res.isolation };
  },
};
