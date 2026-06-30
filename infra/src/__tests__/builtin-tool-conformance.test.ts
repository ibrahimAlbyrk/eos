// Built-in tool conformance — the API-lane bare-named built-ins must match the
// SDK/CLI semantics the model is trained on (Read cat -n line numbers, Edit's
// unique-old_string rule, Grep over ripgrep, Bash timeout/cwd), and the nested-Task
// loop must run a child ToolRuntime over those built-ins and return its final text.
// Exercises the REAL adapters (NodeToolFileSystem / NodeProcessRunner) against a
// temp dir + the REAL loop — no mocked filesystem/shell.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeToolFileSystem } from "../tools/NodeToolFileSystem.ts";
import { createNodeProcessRunner } from "../tools/NodeProcessRunner.ts";
import { createBuiltinToolRegistry } from "../tools/builtins/registry.ts";
import { runTurn, type RuntimeTool, type ToolGate } from "../../../core/src/use-cases/ToolRuntime.ts";
import { bindBuiltinTool } from "../../../core/src/ports/BuiltinToolRegistry.ts";
import type { ModelClient, ModelTurn } from "../../../core/src/ports/ModelClient.ts";
import type { AgentEvent } from "../../../contracts/src/canonical.ts";

const registry = createBuiltinToolRegistry({ fs: createNodeToolFileSystem(), proc: createNodeProcessRunner() });
const allow: ToolGate = { async decide() { return { allow: true }; } };

let dir: string;
before(() => { dir = mkdtempSync(join(tmpdir(), "eos-builtins-")); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

// Invoke one built-in by its bare canonical name, cwd-scoped to the temp dir.
function call(name: string, input: Record<string, unknown>): Promise<string> {
  const t = registry.get(name);
  if (!t) throw new Error(`missing built-in ${name}`);
  return t.execute(input, { cwd: dir });
}

function scriptedModel(turns: ModelTurn[]): ModelClient {
  let i = 0;
  return { async createTurn() { return turns[Math.min(i++, turns.length - 1)]; } };
}

describe("built-in tools — registry has bare canonical names", () => {
  it("registers exactly the 15 bare-named built-ins (Task is a separate closure)", () => {
    const names = registry.list().map((t) => t.name).sort();
    assert.deepEqual(names, [
      "Bash", "BashOutput", "Edit", "ExitPlanMode", "Glob", "Grep", "KillShell",
      "LS", "MultiEdit", "NotebookEdit", "Read", "TodoWrite", "WebFetch", "WebSearch", "Write",
    ]);
  });
});

describe("Read — cat -n line numbers", () => {
  it("prefixes each line with a right-padded 1-based number + tab", async () => {
    await call("Write", { file_path: "r.txt", content: "alpha\nbeta\ngamma\n" });
    const out = await call("Read", { file_path: "r.txt" });
    assert.equal(out, "     1\talpha\n     2\tbeta\n     3\tgamma");
  });
  it("honors offset + limit (numbers stay absolute)", async () => {
    const out = await call("Read", { file_path: "r.txt", offset: 2, limit: 1 });
    assert.equal(out, "     2\tbeta");
  });
});

describe("Write / Edit — overwrite + unique old_string", () => {
  it("Write overwrites and Edit replaces a unique occurrence", async () => {
    await call("Write", { file_path: "e.txt", content: "one two three" });
    await call("Edit", { file_path: "e.txt", old_string: "two", new_string: "TWO" });
    assert.equal(readFileSync(join(dir, "e.txt"), "utf8"), "one TWO three");
  });
  it("Edit rejects a non-unique old_string unless replace_all", async () => {
    await call("Write", { file_path: "d.txt", content: "x x x" });
    await assert.rejects(() => call("Edit", { file_path: "d.txt", old_string: "x", new_string: "y" }), /not unique/);
    await call("Edit", { file_path: "d.txt", old_string: "x", new_string: "y", replace_all: true });
    assert.equal(readFileSync(join(dir, "d.txt"), "utf8"), "y y y");
  });
  it("Edit rejects a missing old_string", async () => {
    await assert.rejects(() => call("Edit", { file_path: "e.txt", old_string: "absent", new_string: "z" }), /not found/);
  });
  it("MultiEdit applies edits sequentially and atomically", async () => {
    await call("Write", { file_path: "m.txt", content: "a b c" });
    await call("MultiEdit", { file_path: "m.txt", edits: [{ old_string: "a", new_string: "A" }, { old_string: "c", new_string: "C" }] });
    assert.equal(readFileSync(join(dir, "m.txt"), "utf8"), "A b C");
  });
});

describe("Grep — ripgrep semantics", () => {
  it("default output_mode lists files with matches", async () => {
    await call("Write", { file_path: "hit.txt", content: "find the needle here" });
    await call("Write", { file_path: "miss.txt", content: "only hay" });
    const out = await call("Grep", { pattern: "needle" });
    assert.match(out, /hit\.txt/);
    assert.doesNotMatch(out, /miss\.txt/);
  });
  it("content mode with -n returns line-numbered matches", async () => {
    const out = await call("Grep", { pattern: "needle", output_mode: "content", "-n": true });
    assert.match(out, /needle/);
    assert.match(out, /1:/); // line number prefix
  });
  it("no match returns a clear sentinel", async () => {
    assert.equal(await call("Grep", { pattern: "zzz_nomatch_zzz" }), "(no matches)");
  });
});

describe("Glob — pattern match", () => {
  it("matches by ** and sorts results", async () => {
    await call("Write", { file_path: "g/one.ts", content: "1" });
    await call("Write", { file_path: "g/sub/two.ts", content: "2" });
    const out = await call("Glob", { pattern: "**/*.ts", path: "g" });
    assert.match(out, /one\.ts/);
    assert.match(out, /two\.ts/);
  });
});

describe("LS — directory listing", () => {
  it("lists entries with directories suffixed by /", async () => {
    const out = await call("LS", { path: "g" });
    assert.match(out, /sub\//);
    assert.match(out, /one\.ts/);
  });
});

describe("Bash — timeout + cwd scope", () => {
  it("runs in the worker cwd", async () => {
    await call("Bash", { command: "echo scoped > scoped.txt" });
    assert.ok(existsSync(join(dir, "scoped.txt")), "the command ran in the worker cwd");
  });
  it("reports a non-zero exit code", async () => {
    assert.match(await call("Bash", { command: "exit 3" }), /exit code: 3/);
  });
  it("kills a command that exceeds its timeout", async () => {
    const out = await call("Bash", { command: "sleep 5", timeout: 150 });
    assert.match(out, /timed out/);
  });
  it("background shell: start → read → output is captured", async () => {
    const started = await call("Bash", { command: "echo bg-out", run_in_background: true });
    const id = started.match(/id (\S+)\b/)?.[1];
    assert.ok(id, "a background shell id was returned");
    // Give the shell a beat to produce output, then read incrementally.
    await new Promise((r) => setTimeout(r, 150));
    assert.match(await call("BashOutput", { bash_id: id! }), /bg-out/);
  });
});

describe("WebSearch / ExitPlanMode — declared surface limitations", () => {
  it("WebSearch reports no provider (v1 limitation)", async () => {
    await assert.rejects(() => call("WebSearch", { query: "x" }), /no search provider/);
  });
  it("ExitPlanMode is a no-op acknowledgment (Eos has no plan mode)", async () => {
    assert.match(await call("ExitPlanMode", { plan: "do x" }), /no plan permission mode/);
  });
});

// ─── Nested Task loop — a tool whose execute drives a CHILD ToolRuntime over the
// real built-ins, returns the child's final text, and is depth-capped. Mirrors the
// manager Task closure's mechanism with infra-local pieces. ────────────────────────

const MAX_DEPTH = 2;
function makeTaskTool(depth: number, signal: { aborted: boolean }): RuntimeTool {
  return {
    name: "Task",
    async execute(input) {
      if (depth >= MAX_DEPTH) return `depth limit reached (max ${MAX_DEPTH})`;
      const childTools = new Map<string, RuntimeTool>();
      for (const t of registry.list()) childTools.set(t.name, bindBuiltinTool(t, { cwd: dir }));
      if (depth + 1 < MAX_DEPTH) childTools.set("Task", makeTaskTool(depth + 1, signal));
      // Child uses a REAL built-in (Write), then ends with text.
      const childModel = scriptedModel([
        { toolCalls: [{ callId: "cw", name: "Write", input: { file_path: `child-${depth}.txt`, content: "from child" } }], stopReason: "tool_use" },
        { text: `child ${depth} done`, toolCalls: [], stopReason: "end_turn" },
      ]);
      let finalText = "";
      const childEmit = (e: AgentEvent): void => {
        if (e.type === "message" && e.role === "assistant") {
          const text = e.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
          if (text) finalText = text;
        }
      };
      await runTurn({ model: childModel, tools: childTools, gate: allow, emit: childEmit, signal }, [{ role: "user", content: String(input.prompt ?? "") }]);
      return finalText || "(no text)";
    },
  };
}

describe("Task subagent — nested loop over real built-ins", () => {
  it("runs a child loop that uses a built-in and returns the child's final text", async () => {
    const signal = { aborted: false };
    const parent = scriptedModel([
      { toolCalls: [{ callId: "pt", name: "Task", input: { subagent_type: "general-purpose", description: "d", prompt: "investigate" } }], stopReason: "tool_use" },
      { text: "parent done", toolCalls: [], stopReason: "end_turn" },
    ]);
    const results: string[] = [];
    const emit = (e: AgentEvent): void => {
      if (e.type === "message" && e.role === "tool") {
        for (const b of e.blocks) if (b.type === "tool_result") results.push(b.content);
      }
    };
    await runTurn({ model: parent, tools: new Map([["Task", makeTaskTool(0, signal)]]), gate: allow, emit, signal }, [{ role: "user", content: "go" }]);
    assert.ok(existsSync(join(dir, "child-0.txt")), "the child used the Write built-in");
    assert.deepEqual(results, ["child 0 done"], "the Task result is the child's final assistant text");
  });

  it("returns an error result over the depth cap instead of recursing", async () => {
    const capped = makeTaskTool(MAX_DEPTH, { aborted: false });
    assert.match(await capped.execute({ prompt: "x" }), /depth limit/);
  });
});
