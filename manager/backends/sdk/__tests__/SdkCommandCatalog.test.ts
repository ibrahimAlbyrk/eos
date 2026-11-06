import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkCommandCatalog, fileCommandListStore, type CommandListStore, type FetchSlashCommands } from "../SdkCommandCatalog.ts";
import type { CommandItem } from "../../../../contracts/src/http.ts";

const COMMANDS = [
  { name: "design", description: "Make a new Design artifact from a brief", argumentHint: "[what to design]", builtin: true },
  { name: "pdf", description: "Work with PDF files", argumentHint: "" },
  { name: "model", description: "Set the AI model", argumentHint: "<model>", builtin: true },
  { name: "color", description: "Set the prompt bar color", argumentHint: "", builtin: true },
  { name: "__remote-workflow", description: "internal", argumentHint: "", builtin: true },
];

const DESIGN: CommandItem = { name: "design", description: "Make a new Design artifact from a brief", source: "claude", argumentHint: "[what to design]" };
const PDF: CommandItem = { name: "pdf", description: "Work with PDF files", source: "skill" };

function memoryStore(initial: Record<string, CommandItem[]> = {}) {
  const writes: Array<Record<string, CommandItem[]>> = [];
  const store: CommandListStore = { read: () => initial, write: (lists) => { writes.push(lists); } };
  return { store, writes };
}

function catalog(fetchCommands: FetchSlashCommands, store?: CommandListStore) {
  return createSdkCommandCatalog({ buildEnv: async () => ({ E: "1" }), fetchCommands, ...(store ? { store } : {}) });
}

describe("SdkCommandCatalog", () => {
  it("lists Claude Code's own commands, minus the ones the dashboard drives itself or a terminal needs", async () => {
    const seen: Array<{ cwd: string; env: Record<string, string> }> = [];
    const items = await catalog(async (cwd, env) => { seen.push({ cwd, env }); return COMMANDS; }).list("/repo");
    assert.deepEqual(items, [DESIGN, PDF]);
    assert.deepEqual(seen, [{ cwd: "/repo", env: { E: "1" } }]);
  });

  it("asks a process only for a folder it has no list for", async () => {
    let calls = 0;
    const c = catalog(async () => { calls++; return COMMANDS; });
    await c.list("/repo");
    await c.list("/repo");
    assert.equal(calls, 1);
    await c.list("/other");
    assert.equal(calls, 2);
  });

  it("a session's own list fills the folder without a process, and replaces an older one", async () => {
    let calls = 0;
    const c = catalog(async () => { calls++; return COMMANDS.slice(0, 1); });
    c.seed("/repo", COMMANDS);
    assert.deepEqual(await c.list("/repo"), [DESIGN, PDF]);
    assert.equal(calls, 0);
    c.seed("/repo", COMMANDS.slice(1, 2));
    assert.deepEqual(await c.list("/repo"), [PDF]);
  });

  it("starts from the saved lists and saves only real changes", async () => {
    let calls = 0;
    const { store, writes } = memoryStore({ "/repo": [PDF] });
    const c = catalog(async () => { calls++; return COMMANDS; }, store);
    assert.deepEqual(await c.list("/repo"), [PDF]);
    assert.equal(calls, 0);
    c.seed("/repo", COMMANDS.slice(1, 2));
    assert.equal(writes.length, 0);
    c.seed("/repo", COMMANDS);
    assert.deepEqual(writes, [{ "/repo": [DESIGN, PDF] }]);
  });

  it("a failed listing answers nothing and is tried again next time", async () => {
    let fail = true;
    const c = catalog(async () => { if (fail) throw new Error("no binary"); return COMMANDS.slice(0, 1); });
    assert.deepEqual(await c.list("/repo"), []);
    fail = false;
    assert.deepEqual(await c.list("/repo"), [DESIGN]);
  });

  it("the file store round-trips and reads a missing or broken file as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "eos-cmds-"));
    try {
      const path = join(dir, "claude-commands.json");
      const store = fileCommandListStore(path);
      assert.deepEqual(store.read(), {});
      store.write({ "/repo": [PDF] });
      assert.deepEqual(store.read(), { "/repo": [PDF] });
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "/repo": [PDF] });
      assert.deepEqual(fileCommandListStore(join(dir, "nope", "x.json")).read(), {});
      store.write([] as unknown as Record<string, CommandItem[]>);
      assert.deepEqual(store.read(), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
