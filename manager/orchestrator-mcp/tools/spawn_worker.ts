import { z } from "zod";
import type { McpToolModule } from "../tool-registry.ts";
import { safeText } from "../tool-registry.ts";

export const spawnWorkerTool: McpToolModule = {
  name: "spawn_worker",
  register(server, session): void {
    server.registerTool(
      "spawn_worker",
      {
        description:
          "Spawn a new background Claude worker to do concrete work. In a git repository the worker runs in an ISOLATED git worktree on its own cm-* branch — NOT in your project directory; its changes stay invisible to the user's checkout until the user integrates them via the dashboard. Outside a git repo it runs directly in your cwd.\n\nWhen to use: every time the user requests code edits, builds, tests, refactors, investigations, or any other concrete action. You never do the work yourself; you spawn workers to do it.\n\nWhen NOT to use: for read-only orchestration tasks (checking worker state, listing pending permissions) — use the dedicated tools for those.\n\nDecomposition: spawn ONE worker per tightly-coupled unit of work. Spawn multiple in parallel when the parts are truly independent (no shared files, no sequential dependency).\n\nLifecycle: worker startup takes a few seconds. The worker receives `prompt` as its first user-turn, runs until it calls send_message_to_parent, then stays idle waiting for follow-ups. Call kill_worker only after the user has acknowledged the result AND integrated or discarded the worker's branch — deleting a worker destroys its worktree.\n\nThe worker automatically inherits the project's worker system prompt, which already covers reporting structure, the result:/needs input:/failed: signal protocol, and the worktree Handover line — do not repeat those in `prompt`.\n\nReturns { id, port, name }. Use that id with get_worker, message_worker, and kill_worker.",
        inputSchema: {
          prompt: z.string().describe(
            "The directive for the worker. Follow the worker prompt template from your system prompt: directive sentence, Context (relevant files/branches), Acceptance (concrete done-check), Out of scope (if non-obvious), Report (task-specific items). Workers already know the signal protocol — do not repeat it.",
          ),
          name: z.string().optional().describe(
            "Friendly slug for the worker (kebab-case). Should describe the outcome, not the action. Good: 'refactor-auth-tokens', 'add-billing-tests'. Bad: 'worker-1', 'fix-stuff', 'task'.",
          ),
          withGateway: z.boolean().optional().describe(
            "Default true. Routes the worker's tool calls through the permission gateway. Set false only when you explicitly want a worker to run without permission checks (rare; needs strong justification).",
          ),
          model: z.string().optional().describe(
            "Claude model: 'opus' (default; ambiguous, multi-file, or debugging work), 'sonnet' (balanced — well-specified routine work), 'haiku' (fastest/cheapest — trivial writes, summaries, simple greps). When in doubt, omit and let it default to opus.",
          ),
        },
      },
      async ({ prompt, name, withGateway, model }) =>
        safeText(async () => {
          const body: Record<string, unknown> = {
            prompt, name, model,
            withGateway: withGateway ?? true,
            parentId: session.selfId,
          };
          if (session.isGitRepo) body.worktreeFrom = session.cwd;
          else body.cwd = session.cwd;
          return await session.api("POST", "/workers", body);
        }),
    );
  },
};
