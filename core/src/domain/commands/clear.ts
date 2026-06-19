// /clear — reset the conversation on whichever backend the worker runs on.
// Resolves to the per-backend contextClear capability (CLI: native /clear over
// the PTY; claude-sdk: query restart; in-process: drop the message buffer), then
// runs the shared daemon-side side effects (pending-queue clear, peer cancel,
// conversation_cleared marker) so both lanes converge on the same observable
// outcome. The command carries no message record → no user_message chat event.

import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "../slash-command.ts";
import type { AgentCapabilities } from "../../ports/AgentBackend.ts";

export const clearCommand: SlashCommand = {
  name: "clear",
  description: "Clear conversation history (agent context + chat)",

  // Takes no args, and only when the backend can actually reset its context.
  accepts(args: string, caps: AgentCapabilities): boolean {
    return args === "" && caps.contextClear === true;
  },

  async execute(ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const reset = (await ctx.session.clearContext?.()) ?? { ok: false };
    // Daemon-side bookkeeping — owned by the command (not the CLI SessionEnd hook,
    // which is now an idempotent fallback) so the SDK/in-process lanes get it too.
    ctx.services.clearPendingQueue(ctx.workerId);
    ctx.services.cancelPeerRequests(ctx.workerId);
    ctx.services.appendConversationCleared(ctx.workerId, { via: "slash-command" });
    return { status: 200, body: { ok: reset.ok, cleared: true } };
  },
};
