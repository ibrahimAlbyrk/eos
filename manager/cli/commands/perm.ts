import { parseArgs } from "node:util";

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

export const permCommand: Command = {
  name: "perm",
  description: "List, approve (ok), or deny (no) pending permission requests",
  usage: "eos perm [ok <id> [--rewrite '<json>'] | no <id> [--reason '<text>']]",
  async run(args, ctx): Promise<void> {
    const sub = args[0];

    if (sub === "ok") {
      const { values, positionals } = parseArgs({
        args: args.slice(1), allowPositionals: true,
        options: { rewrite: { type: "string" } },
      });
      const id = positionals[0];
      if (!id) { console.error("usage: eos perm ok <id> [--rewrite '<json>']"); process.exit(1); }
      const body: Record<string, unknown> = { decision: "allow" };
      if (values.rewrite) {
        try { body.updatedInput = JSON.parse(values.rewrite); }
        catch { console.error("--rewrite must be valid JSON"); process.exit(1); }
      }
      const res = await ctx.api("POST", `/pending/${id}/decision`, body);
      console.log(JSON.stringify(res));
      return;
    }

    if (sub === "no") {
      const { values, positionals } = parseArgs({
        args: args.slice(1), allowPositionals: true,
        options: { reason: { type: "string" } },
      });
      const id = positionals[0];
      if (!id) { console.error("usage: eos perm no <id> [--reason '<text>']"); process.exit(1); }
      const res = await ctx.api("POST", `/pending/${id}/decision`, { decision: "deny", reason: values.reason ?? "denied" });
      console.log(JSON.stringify(res));
      return;
    }

    if (sub !== undefined) {
      console.error("usage: eos perm [ok <id> [--rewrite '<json>'] | no <id> [--reason '<text>']]");
      process.exit(1);
    }

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
