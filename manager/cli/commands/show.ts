import type { Command } from "./Command.ts";
import { fmtTs, fmtDur, exitCodeLabel, type WorkerRowMin } from "../format.ts";

interface EventRow {
  ts: number;
  type: string;
  payload: string | null;
}

function formatEventPayload(type: string, raw: string | null): string {
  if (!raw) return "";
  try {
    const p = JSON.parse(raw);
    if (type === "hook") return ` event=${p.event}`;
    if (type === "state") return ` -> ${p.state}`;
    if (type === "jsonl") {
      if (p.kind === "tool_use") return ` ${p.name}: ${JSON.stringify(p.input).slice(0, 60)}`;
      if (p.kind === "tool_result") return ` ${p.isError ? "ERR " : ""}${(p.text || "").slice(0, 60)}`;
      if (p.kind === "assistant_text") return `: ${(p.text || "").slice(0, 60).replace(/\s+/g, " ")}`;
    }
    if (type === "lifecycle") return ` ${p.phase}`;
    if (type === "worktree") return ` ${p.phase}`;
    if (type === "exit") return ` code=${p.code}`;
    return " " + JSON.stringify(p).slice(0, 80);
  } catch {
    return " " + raw.slice(0, 60);
  }
}

export const showCommand: Command = {
  name: "show",
  aliases: ["info"],
  description: "Show worker/orchestrator detail + last 50 events",
  usage: "eos show <id>",
  async run(args, ctx): Promise<void> {
    if (!args[0]) { console.error("usage: show <id>"); process.exit(1); }
    const id = args[0];
    const w = (await ctx.api("GET", `/workers/${id}`)) as WorkerRowMin;
    console.log(`id:         ${w.id}`);
    console.log(`state:      ${w.state}`);
    console.log(`name:       ${w.name ?? "-"}`);
    console.log(`pid:        ${w.pid ?? "-"}`);
    console.log(`port:       ${w.port}`);
    console.log(`cwd:        ${w.cwd ?? "-"}`);
    console.log(`worktree:   ${w.worktree_from ?? "-"}  branch=${w.branch ?? "-"}`);
    console.log(`duration:   ${fmtDur(w.started_at, w.ended_at)}`);
    console.log(`prompt:     ${w.prompt}`);
    if (w.exit_code !== null) console.log(`exit_code:  ${exitCodeLabel(w.exit_code)}`);

    const events = (await ctx.api("GET", `/workers/${id}/events?limit=50`)) as EventRow[];
    console.log(`\nrecent events (${events.length}):`);
    for (const e of events) {
      console.log(`  ${fmtTs(e.ts)}  ${e.type.padEnd(10)}${formatEventPayload(e.type, e.payload)}`);
    }
  },
};
