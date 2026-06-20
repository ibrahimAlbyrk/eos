import { z } from "zod";
import { EFFORT_LEVELS } from "../../../contracts/src/shared.ts";
import type { ToolDefinition } from "../types.ts";
import { commandRequest } from "../../../contracts/src/commands/types.ts";
import { spawnWorkerCommand } from "../../../contracts/src/commands/defs.ts";
import type { SpawnWorkerRequest } from "../../../contracts/src/http.ts";

export const spawnWorkerDef: ToolDefinition = {
  name: "spawn_worker",
  visibility: "orchestrator",
  inputSchema: {
    prompt: z.string().describe(
      "The directive for the worker. Follow the worker prompt template from your system prompt: directive sentence, Context (relevant files/branches), Acceptance (concrete done-check), Out of scope (if non-obvious), Report (task-specific items). Workers already know the signal protocol — do not repeat it.",
    ),
    name: z.string().optional().describe(
      "Friendly slug for the worker (kebab-case). Should describe the outcome, not the action. Good: 'refactor-auth-tokens', 'add-billing-tests'. Bad: 'worker-1', 'fix-stuff', 'task'.",
    ),
    model: z.string().optional().describe(
      "Claude model: 'opus' (default; ambiguous, multi-file, or debugging work), 'sonnet' (balanced — well-specified routine work), 'haiku' (fastest/cheapest — trivial writes, summaries, simple greps), 'fable' (most powerful — the very hardest problems where opus falls short). When in doubt, omit and let it default to opus.",
    ),
    effort: z.enum(EFFORT_LEVELS).optional().describe(
      "Reasoning effort for the worker. ONLY pass this when the chosen model supports effort — opus, fable, and sonnet do; haiku does NOT (omit it there). 'low' (trivial mechanical edits, summaries), 'medium' (routine well-specified work), 'high' (substantial but straightforward implementation), 'xhigh' (default — complex debugging, design, anything where wrong output is expensive), 'max' (correctness-critical, cost-insensitive). When in doubt, omit and let it default to xhigh.",
    ),
    workspaceOf: z.string().optional().describe(
      "Spawn this worker INSIDE an existing worker's isolated worktree instead of a fresh one. Use it to review, continue, or fix that worker's work with direct file access — never read another worker's worktree via your own shell. Pass the id of a worker you spawned (attaching to another orchestrator's worker is rejected). Only allowed while that worker is idle (fails with a conflict while it is busy); for plain follow-ups prefer message_worker to the same worker.",
    ),
    collaborate: z.boolean().optional().describe(
      "Give this worker the peer tools (list_peers / ask_peer / respond_to_peer) so it can consult — and be consulted by — the other collaborate workers you spawn under you (its siblings). Enable it on BOTH sides of a runtime information dependency: e.g. domain-expert 'providers' plus the 'consumer' that queries them as it works. Leave it OFF for independent parallel work. See the peer-collaboration section of your instructions for when this pays off and how to set it up.",
    ),
    from: z.string().optional().describe(
      "Available worker to spawn from (see the Available workers section of your instructions). It pre-fills this worker's defaults (model, effort, permission mode, persistence) and frames its instructions — fields you pass explicitly still win. Match the task against each available worker's 'when to use'; omit ⇒ defaults to the general-purpose worker.",
    ),
    toolsAllow: z.array(z.string()).optional().describe(
      "Fence THIS worker's tools for a one-off (globs, e.g. 'Read', 'mcp__*') — no need to define a reusable worker just to restrict capability. Allowlist is exhaustive: anything not listed is denied. Empty/omit ⇒ inherit all tools. Wins over a `from` definition's allowlist.",
    ),
    toolsDeny: z.array(z.string()).optional().describe(
      "Subtract tools from THIS one-off worker (globs). Always subtracts, even from an allowlist. Wins over a `from` definition's denylist.",
    ),
    editRegex: z.string().optional().describe(
      "Confine THIS one-off worker's file edits to paths matching this regex (e.g. 'src/.*\\\\.ts$'). Enforced at the gate. Wins over a `from` definition's editRegex.",
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
      "Arm a dynamic loop on this worker AT SPAWN so it can't finish until the goal is provably met — PREFER this over spawning then attaching with dynamic_loop (a separate attach can miss a report the worker sends before the loop exists). Make goal.criteria CHECKABLE: a `verify` shell command wherever possible. strategy: command/judge/hybrid (default hybrid). limit: omit for unbounded (netted by no-progress), or a number to cap attempts.",
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
    return ctx.api(req.method, req.path, req.body);
  },
};
