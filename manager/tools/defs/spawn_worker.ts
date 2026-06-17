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
  },
  handler: async (ctx, args) => {
    const { prompt, name, model, effort, workspaceOf, collaborate } = args as {
      prompt: string; name?: string; model?: string; effort?: string; workspaceOf?: string; collaborate?: boolean;
    };
    const data: SpawnWorkerRequest = {
      prompt, name, model,
      withGateway: true,
      parentId: ctx.selfId,
    };
    if (effort) data.effort = effort;
    if (collaborate) data.collaborate = true;
    if (workspaceOf) data.workspaceOf = workspaceOf;
    else if (ctx.isGitRepo()) data.worktreeFrom = ctx.cwd;
    else data.cwd = ctx.cwd;
    const req = commandRequest(spawnWorkerCommand, {}, data);
    return ctx.api(req.method, req.path, req.body);
  },
};
