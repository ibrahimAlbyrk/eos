import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSdkCommandCatalog, type FetchSlashCommands } from "../SdkCommandCatalog.ts";

const COMMANDS = [
  { name: "design", description: "Make a new Design artifact from a brief", argumentHint: "[what to design]", builtin: true },
  { name: "pdf", description: "Work with PDF files", argumentHint: "" },
  { name: "model", description: "Set the AI model", argumentHint: "<model>", builtin: true },
  { name: "color", description: "Set the prompt bar color", argumentHint: "", builtin: true },
  { name: "__remote-workflow", description: "internal", argumentHint: "", builtin: true },
];

function catalog(fetchCommands: FetchSlashCommands, clock = { t: 0 }) {
  return createSdkCommandCatalog({ buildEnv: async () => ({ E: "1" }), fetchCommands, now: () => clock.t });
}

describe("SdkCommandCatalog", () => {
  it("lists Claude Code's own commands, minus the ones the dashboard drives itself or a terminal needs", async () => {
    const seen: Array<{ cwd: string; env: Record<string, string> }> = [];
    const items = await catalog(async (cwd, env) => { seen.push({ cwd, env }); return COMMANDS; }).list("/repo");
    assert.deepEqual(items, [
      { name: "design", description: "Make a new Design artifact from a brief", source: "claude", argumentHint: "[what to design]" },
      { name: "pdf", description: "Work with PDF files", source: "skill" },
    ]);
    assert.deepEqual(seen, [{ cwd: "/repo", env: { E: "1" } }]);
  });

  it("caches per folder; a stale entry answers at once and refreshes in the background", async () => {
    const clock = { t: 0 };
    let calls = 0;
    const c = catalog(async () => { calls++; return calls === 1 ? COMMANDS.slice(0, 1) : COMMANDS.slice(0, 2); }, clock);
    assert.equal((await c.list("/repo")).length, 1);
    assert.equal((await c.list("/repo")).length, 1);
    assert.equal(calls, 1);
    clock.t = 11 * 60_000;
    assert.equal((await c.list("/repo")).length, 1); // stale answer, refresh started
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 2);
    assert.equal((await c.list("/repo")).length, 2);
  });

  it("a failed listing falls back to the last good list (or nothing)", async () => {
    const clock = { t: 0 };
    let fail = true;
    const c = catalog(async () => { if (fail) throw new Error("no binary"); return COMMANDS.slice(0, 1); }, clock);
    assert.deepEqual(await c.list("/repo"), []);
    fail = false;
    assert.equal((await c.list("/repo")).length, 1);
  });
});
