// /compact [instructions] — condense the conversation into a summary and continue
// from it (context compaction). The summarizer run can take minutes, so the
// command only STARTS it and answers 202; progress reaches the UI through the
// compaction_* timeline events. Text after the command steers what the summary
// keeps. Gated on the backend's contextCompaction capability, never on kind —
// on a lane without it "/compact" flows on as a normal message.

import type { SlashCommand, SlashCommandContext, SlashCommandResult } from "../slash-command.ts";
import type { AgentCapabilities } from "../../ports/AgentBackend.ts";

export const compactCommand: SlashCommand = {
  name: "compact",
  description: "Summarize the conversation into a fresh context (text after the command steers the summary)",

  accepts(_args: string, caps: AgentCapabilities): boolean {
    return caps.contextCompaction === true;
  },

  async execute(ctx: SlashCommandContext): Promise<SlashCommandResult> {
    const started = ctx.services.startCompaction(ctx.workerId, ctx.args);
    return started.ok
      ? { status: 202, body: { ok: true, compacting: true } }
      : { status: 409, body: { ok: false, error: started.reason } };
  },
};
