import type { Command } from "./Command.ts";
import { fmtDur, short, type WorkerRowMin } from "../format.ts";

export const listCommand: Command = {
  name: "ls",
  aliases: ["list"],
  description: "List all workers (active + completed) with state, duration, location, prompt",
  usage: "eos ls",
  async run(_args, ctx): Promise<void> {
    const workers = (await ctx.api("GET", "/workers")) as WorkerRowMin[];
    if (workers.length === 0) {
      console.log("(no workers)");
      return;
    }
    console.log("ID          STATE     DUR    PID    BRANCH/CWD                              PROMPT");
    for (const w of workers) {
      const loc = w.branch ?? (w.cwd ?? "-").slice(-40);
      const prompt = w.prompt.slice(0, 40).replace(/\s+/g, " ");
      console.log(
        `${short(w.id).padEnd(11)} ${w.state.padEnd(9)} ${fmtDur(w.started_at, w.ended_at).padEnd(6)} ${String(w.pid ?? "-").padEnd(6)} ${loc.padEnd(40)} ${prompt}`,
      );
    }
  },
};
