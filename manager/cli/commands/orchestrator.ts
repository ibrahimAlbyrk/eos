import { parseArgs } from "node:util";

import type { Command } from "./Command.ts";
import { fmtDur } from "../format.ts";

interface OrchestratorRow {
  id: string;
  name: string | null;
  cwd: string | null;
  state: string;
  started_at: number;
  ended_at: number | null;
  is_orchestrator: number;
}

async function newOrchestrator(args: string[], ctx: Parameters<Command["run"]>[1]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      cwd: { type: "string" },
      name: { type: "string" },
      model: { type: "string" },
    },
    strict: true,
  });
  if (!values.cwd) { console.error("error: --cwd required"); process.exit(1); }
  const res = (await ctx.api("POST", "/orchestrators", {
    name: values.name, cwd: values.cwd, model: values.model,
  })) as { id: string; port: number; name?: string };
  console.log(`spawned orchestrator: ${res.id}  name=${res.name ?? values.name ?? "(auto)"}  cwd=${values.cwd}`);
}

async function listOrchestrators(ctx: Parameters<Command["run"]>[1]): Promise<void> {
  const rows = (await ctx.api("GET", "/orchestrators")) as OrchestratorRow[];
  if (rows.length === 0) { console.log("(no orchestrators)"); return; }
  console.log("ID         NAME                 STATE     DUR    CWD");
  for (const o of rows) {
    console.log(
      `${o.id.padEnd(10)} ${(o.name ?? "-").slice(0, 20).padEnd(20)} ${o.state.padEnd(9)} ${fmtDur(o.started_at, o.ended_at).padEnd(6)} ${o.cwd ?? "-"}`,
    );
  }
}

export const orchestratorCommand: Command = {
  name: "orch",
  aliases: ["orchestrator"],
  description: "Create or list orchestrators",
  usage: "eos orch [ls | new --cwd <path> [--name <n>] [--model opus|sonnet|haiku]]",
  async run(args, ctx): Promise<void> {
    const sub = args[0];
    if (sub === "new" || sub === "create") {
      await newOrchestrator(args.slice(1), ctx);
      return;
    }
    if (sub === "list" || sub === "ls" || sub === undefined) {
      await listOrchestrators(ctx);
      return;
    }
    console.error("usage: eos orch [ls | new --cwd <path> --name <n> [--model opus]]");
    process.exit(1);
  },
};

// Used by the chat command — exposed so the dispatcher can pick the single
// active orchestrator when --to is omitted.
export async function resolveChatTarget(
  explicit: string | undefined,
  ctx: Parameters<Command["run"]>[1],
): Promise<string> {
  if (explicit) return explicit;
  const rows = (await ctx.api("GET", "/orchestrators")) as OrchestratorRow[];
  const active = rows.filter((o) => o.state !== "DONE");
  if (active.length === 0) {
    console.error("error: no active orchestrator. Create one with: eos orch new --cwd <path> --name <n>");
    process.exit(1);
  }
  if (active.length === 1) return active[0].id;
  console.error("error: multiple orchestrators running — specify with --to <id>");
  for (const o of active) console.error(`  ${o.id}  ${o.name ?? "-"}  ${o.cwd ?? "-"}`);
  process.exit(1);
}
