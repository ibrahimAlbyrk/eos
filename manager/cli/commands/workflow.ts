// `eos workflow` — the operator's zero-LLM front door to the deterministic
// node-graph engine (design A6.3). No orchestrator, no agent: `validate` parses +
// type-checks a definition file entirely offline; `run` loads a file (or names a
// stored definition) and launches it through the operator-owned HTTP path, printing
// the run id (and streaming status with --wait). `list` enumerates the local +
// builtin definitions; `status` / `stop` address a run by id.

import { parseArgs } from "node:util";
import { existsSync, readFileSync } from "node:fs";

import type { Command, CommandContext } from "./Command.ts";
import { loadWorkflowFile } from "../../shared/workflow-file.ts";
import { FileWorkflowDefinitionSource, findProjectWorkflowDefinitionsDir } from "../../../infra/src/workflow/FileWorkflowDefinitionSource.ts";
import { BuiltinWorkflowDefinitionSource } from "../../workflows/index.ts";

const TERMINAL = new Set(["passed", "failed", "stopped"]);

// A bare name ("my-flow") names a stored/builtin definition; anything ending .json/
// .md, or an existing path, is a definition FILE the operator authored.
function looksLikeFile(target: string): boolean {
  return target.endsWith(".json") || target.endsWith(".md") || existsSync(target);
}

function loadFileOrExit(target: string): { spec: unknown } {
  if (!existsSync(target)) { console.error(`error: file not found: ${target}`); process.exit(1); }
  const result = loadWorkflowFile(readFileSync(target, "utf8"), !target.endsWith(".md"));
  if (!result.ok) {
    console.error(`error: ${target} is not a valid workflow:`);
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  return { spec: result.def };
}

async function runWorkflow(args: string[], ctx: CommandContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { args: { type: "string" }, wait: { type: "boolean" } },
    allowPositionals: true,
    strict: true,
  });
  const target = positionals[0];
  if (!target) { console.error("usage: eos workflow run <file|name> [--args <json>] [--wait]"); process.exit(1); }

  let runArgs: unknown;
  if (values.args !== undefined) {
    try { runArgs = JSON.parse(values.args); }
    catch (e) { console.error(`error: --args must be valid JSON (${e instanceof Error ? e.message : String(e)})`); process.exit(1); }
  }

  const body = looksLikeFile(target)
    ? { mode: "run-inline", spec: loadFileOrExit(target).spec, args: runArgs }
    : { mode: "run-stored", from: target, args: runArgs };

  const res = (await ctx.api("POST", "/workflows", body)) as { runId: string; status: string };
  console.log(`workflow run started: ${res.runId} (status: ${res.status})`);
  if (values.wait) await waitForRun(res.runId, ctx);
}

async function waitForRun(runId: string, ctx: CommandContext): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const row = (await ctx.api("GET", `/workflows/${runId}`)) as { status: string; result?: unknown };
    if (TERMINAL.has(row.status)) {
      console.log(`status: ${row.status}`);
      if (row.result !== undefined) console.log(JSON.stringify(row.result, null, 2));
      process.exit(row.status === "passed" ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`error: timed out waiting for run ${runId}`);
  process.exit(1);
}

function validateFile(args: string[]): void {
  const target = args[0];
  if (!target) { console.error("usage: eos workflow validate <file>"); process.exit(1); }
  if (!existsSync(target)) { console.error(`error: file not found: ${target}`); process.exit(1); }
  const result = loadWorkflowFile(readFileSync(target, "utf8"), !target.endsWith(".md"));
  if (result.ok) {
    console.log(`ok: ${target} is a valid ${result.kind} workflow "${result.name}"`);
    return;
  }
  console.error(`invalid: ${target}`);
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}

function listDefs(ctx: CommandContext): void {
  const dirs = [{ dir: `${ctx.config.daemon.home}/workflows`, source: "user" as const }];
  const proj = findProjectWorkflowDefinitionsDir(process.cwd());
  if (proj) dirs.push({ dir: proj, source: "project" as const });
  const records = [
    ...new BuiltinWorkflowDefinitionSource().list(),
    ...new FileWorkflowDefinitionSource(dirs).list(),
  ];
  const byName = new Map<string, (typeof records)[number]>();
  for (const r of records) byName.set(r.name, r); // later (file) shadows earlier (builtin)
  if (byName.size === 0) { console.log("(no workflow definitions)"); return; }
  console.log("NAME                 KIND   SOURCE   DESCRIPTION");
  for (const r of byName.values()) {
    const kind = (r as { version?: number }).version === 2 ? "graph" : "tree";
    const desc = (r.description ?? "").replace(/\s+/g, " ").slice(0, 50);
    console.log(`${r.name.slice(0, 20).padEnd(20)} ${kind.padEnd(6)} ${r.source.padEnd(8)} ${desc}`);
  }
}

async function statusRun(args: string[], ctx: CommandContext): Promise<void> {
  const runId = args[0];
  if (!runId) { console.error("usage: eos workflow status <runId>"); process.exit(1); }
  const row = (await ctx.api("GET", `/workflows/${runId}`)) as { id: string; status: string; result?: unknown };
  console.log(`${row.id}: ${row.status}`);
  if (row.result !== undefined) console.log(JSON.stringify(row.result, null, 2));
}

async function stopRun(args: string[], ctx: CommandContext): Promise<void> {
  const runId = args[0];
  if (!runId) { console.error("usage: eos workflow stop <runId>"); process.exit(1); }
  const res = (await ctx.api("POST", "/workflows", { mode: "stop", runId })) as { runId: string; status: string };
  console.log(`run ${res.runId}: ${res.status}`);
}

// Delete a stored (runtime) definition by name. A builtin or unknown name is
// rejected by the daemon; ctx.api prints the clean error and exits non-zero.
async function deleteDef(args: string[], ctx: CommandContext): Promise<void> {
  const name = args[0];
  if (!name) { console.error("usage: eos workflow delete <name>"); process.exit(1); }
  const res = (await ctx.api("DELETE", `/workflows/${encodeURIComponent(name)}`)) as { name: string };
  console.log(`deleted workflow definition: ${res.name}`);
}

export const workflowCommand: Command = {
  name: "workflow",
  aliases: ["wf"],
  description: "Run / validate / inspect workflows (deterministic node-graph engine; no LLM)",
  usage: "eos workflow <run <file|name> [--args <json>] [--wait] | validate <file> | list | status <runId> | stop <runId> | delete <name>>",
  async run(args, ctx): Promise<void> {
    const sub = args[0];
    switch (sub) {
      case "run": await runWorkflow(args.slice(1), ctx); return;
      case "validate": validateFile(args.slice(1)); return;
      case "list": case "ls": listDefs(ctx); return;
      case "status": await statusRun(args.slice(1), ctx); return;
      case "stop": await stopRun(args.slice(1), ctx); return;
      case "delete": case "rm": await deleteDef(args.slice(1), ctx); return;
      default:
        console.error(`usage: ${workflowCommand.usage}`);
        process.exit(1);
    }
  },
};
