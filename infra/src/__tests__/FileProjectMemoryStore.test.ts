import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileProjectMemoryStore } from "../persistence/FileProjectMemoryStore.ts";

function freshDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "eos-mem-")), "memory");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMemory(dir: string, name: string, description: string, type: string, body: string): void {
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  node_type: memory\n  type: ${type}\n---\n\n${body}\n`,
  );
}

test("list parses frontmatter and skips MEMORY.md", async () => {
  const store = new FileProjectMemoryStore();
  const dir = freshDir();
  writeMemory(dir, "alpha", "first one", "project", "body a");
  writeMemory(dir, "beta", "second one", "feedback", "body b");
  writeFileSync(join(dir, "MEMORY.md"), "- [alpha](alpha.md) — first one\n");

  const list = await store.list(dir);
  assert.equal(list.length, 2);
  const alpha = list.find((e) => e.name === "alpha");
  assert.equal(alpha.description, "first one");
  assert.equal(alpha.type, "project");
  assert.ok(alpha.path.endsWith("/alpha.md"));
  assert.equal(list.find((e) => e.name === "beta").type, "feedback");
});

test("list returns [] for a missing directory", async () => {
  const store = new FileProjectMemoryStore();
  assert.deepEqual(await store.list("/does/not/exist/memory"), []);
});

test("softDelete moves the file to .trash and reports existence", async () => {
  const store = new FileProjectMemoryStore();
  const dir = freshDir();
  writeMemory(dir, "doomed", "x", "project", "x");
  assert.equal(await store.softDelete(dir, "doomed"), true);
  assert.equal(existsSync(join(dir, "doomed.md")), false);
  const trash = readdirSync(join(dir, ".trash"));
  assert.equal(trash.length, 1);
  assert.match(trash[0], /^doomed\./);
  assert.equal(await store.softDelete(dir, "doomed"), false);
});

test("readIndex/writeIndex round-trip", async () => {
  const store = new FileProjectMemoryStore();
  const dir = freshDir();
  assert.equal(await store.readIndex(dir), "");
  await store.writeIndex(dir, "- [a](a.md) — x\n");
  assert.equal(await store.readIndex(dir), "- [a](a.md) — x\n");
});
