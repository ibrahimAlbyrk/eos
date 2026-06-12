import { z } from "zod";
import { EFFORT_LEVELS } from "../../../contracts/src/shared.ts";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const spawnWorkerTool: McpToolModule = {
  name: "spawn_worker",
  register(server, session): void {
    server.registerTool(
      "spawn_worker",
      {
        description:
          "Spawn a new background Claude worker to do concrete work. In a git repository the worker runs in an ISOLATED git worktree on its own eos-* branch — NOT in your project directory; its changes stay invisible to the user's checkout until the user integrates them via the dashboard. Outside a git repo it runs directly in your cwd. The user can disable worktrees in settings — the result's `isolation` field (\"worktree\" or \"cwd\") is authoritative for where the worker actually runs; with \"cwd\" its edits land directly in the user's checkout, so avoid parallel workers touching the same files.\n\nWhen to use: every time the user requests code edits, builds, tests, refactors, investigations, or any other concrete action. You never do the work yourself; you spawn workers to do it.\n\nWhen NOT to use: for read-only orchestration tasks (checking worker state, listing pending permissions) — use the dedicated tools for those.\n\nDecomposition: spawn ONE worker per tightly-coupled unit of work. Spawn multiple in parallel when the parts are truly independent (no shared files, no sequential dependency).\n\nLifecycle: worker startup takes a few seconds. The worker receives `prompt` as its first user-turn, runs until it calls send_message_to_parent, then stays idle waiting for follow-ups. Call kill_worker only after the user has acknowledged the result AND integrated or discarded the worker's branch — deleting a worker destroys its worktree.\n\nThe worker automatically inherits the project's worker system prompt, which already covers reporting structure, the result:/needs input:/failed: signal protocol, and the worktree Handover line — do not repeat those in `prompt`.\n\nReturns { id, port, isolation }. Use that id with get_worker, message_worker, and kill_worker.",
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
        },
      },
      async ({ prompt, name, model, effort, workspaceOf }) =>
        safeText(async () => {
          const body: Record<string, unknown> = {
            prompt, name, model,
            withGateway: true,
            parentId: session.selfId,
          };
          if (effort) body.effort = effort;
          if (workspaceOf) body.workspaceOf = workspaceOf;
          else if (session.isGitRepo()) body.worktreeFrom = session.cwd;
          else body.cwd = session.cwd;
          return await session.api("POST", "/workers", body);
        }),
    );
  },
};
