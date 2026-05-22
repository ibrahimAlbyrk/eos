import type { Command } from "./Command.ts";
import { short } from "../format.ts";

interface PendingRow {
  id: string;
  worker_id: string;
  tool_name: string;
  input: string;
  created_at: number;
  expires_at: number;
}

export const pendingCommand: Command = {
  name: "pending",
  description: "List pending permission requests waiting for human approval",
  usage: "claude-manager pending",
  async run(_args, ctx): Promise<void> {
    const rows = (await ctx.api("GET", "/pending")) as PendingRow[];
    if (rows.length === 0) { console.log("(no pending)"); return; }
    const now = Date.now();
    console.log("ID           WORKER       TOOL    EXPIRES IN  INPUT");
    for (const r of rows) {
      const secs = Math.max(0, Math.round((r.expires_at - now) / 1000));
      let input = "";
      try {
        const i = JSON.parse(r.input);
        input = (i.command ?? i.file_path ?? i.url ?? JSON.stringify(i)).slice(0, 50);
      } catch { input = r.input.slice(0, 50); }
      console.log(`${r.id.padEnd(12)} ${short(r.worker_id).padEnd(12)} ${r.tool_name.padEnd(7)} ${(secs + "s").padEnd(11)} ${input}`);
    }
  },
};
