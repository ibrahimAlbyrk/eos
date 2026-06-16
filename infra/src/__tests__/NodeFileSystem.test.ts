import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFileSystem } from "../filesystem/NodeFileSystem.ts";
import { ConflictError, NotFoundError } from "../../../core/src/errors/index.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eos-fs-test-"));
}
function fsFor(root: string) {
  return createNodeFileSystem({ trashDir: join(root, ".trash"), platform: "linux" });
}

test("listDir returns dirs-first, hides node_modules + dotfiles", async () => {
  const root = tmp();
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "a.txt"), "hi");
  writeFileSync(join(root, ".hidden"), "x");
  const entries = await fsFor(root).listDir(root, { root });
  assert.deepEqual(entries.map((e) => e.name), ["src", "a.txt"]);
  assert.equal(entries[0].type, "directory");
  assert.equal(entries[1].relativePath, "a.txt");
  rmSync(root, { recursive: true, force: true });
});

test("listDir includeHidden + applyIgnore:false surfaces everything", async () => {
  const root = tmp();
  writeFileSync(join(root, ".env"), "X=1");
  mkdirSync(join(root, "node_modules"));
  const names = (await fsFor(root).listDir(root, { root, includeHidden: true, applyIgnore: false })).map((e) => e.name);
  assert.ok(names.includes(".env"));
  assert.ok(names.includes("node_modules"));
  rmSync(root, { recursive: true, force: true });
});

test("listDir resolves a symlink's target type", async () => {
  const root = tmp();
  mkdirSync(join(root, "target"));
  symlinkSync(join(root, "target"), join(root, "link"));
  const link = (await fsFor(root).listDir(root, { root })).find((e) => e.name === "link");
  assert.ok(link);
  assert.equal(link.isSymlink, true);
  assert.equal(link.type, "directory");
  rmSync(root, { recursive: true, force: true });
});

test("createFile is O_EXCL — collision throws ConflictError", async () => {
  const root = tmp();
  const fs = fsFor(root);
  await fs.createFile(join(root, "new.txt"), "hello");
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "hello");
  await assert.rejects(() => fs.createFile(join(root, "new.txt")), ConflictError);
  rmSync(root, { recursive: true, force: true });
});

test("mkdir collision → ConflictError, missing parent → NotFoundError", async () => {
  const root = tmp();
  const fs = fsFor(root);
  await fs.mkdir(join(root, "d"));
  await assert.rejects(() => fs.mkdir(join(root, "d")), ConflictError);
  await assert.rejects(() => fs.mkdir(join(root, "nope", "deep")), NotFoundError);
  rmSync(root, { recursive: true, force: true });
});

test("rename refuses to clobber an existing sibling", async () => {
  const root = tmp();
  writeFileSync(join(root, "a.txt"), "a");
  writeFileSync(join(root, "b.txt"), "b");
  const fs = fsFor(root);
  await assert.rejects(() => fs.rename(join(root, "a.txt"), join(root, "b.txt")), ConflictError);
  await fs.rename(join(root, "a.txt"), join(root, "c.txt"));
  assert.ok(existsSync(join(root, "c.txt")) && !existsSync(join(root, "a.txt")));
  rmSync(root, { recursive: true, force: true });
});

test("move honors the overwrite flag", async () => {
  const root = tmp();
  mkdirSync(join(root, "dst"));
  writeFileSync(join(root, "f.txt"), "one");
  writeFileSync(join(root, "dst", "f.txt"), "two");
  const fs = fsFor(root);
  await assert.rejects(() => fs.move(join(root, "f.txt"), join(root, "dst", "f.txt")), ConflictError);
  await fs.move(join(root, "f.txt"), join(root, "dst", "f.txt"), { overwrite: true });
  assert.equal(readFileSync(join(root, "dst", "f.txt"), "utf8"), "one");
  rmSync(root, { recursive: true, force: true });
});

test("trash relocates into the trash dir on non-darwin (reversible)", async () => {
  const root = tmp();
  const trashDir = join(root, ".trash");
  writeFileSync(join(root, "doomed.txt"), "bye");
  await fsFor(root).trash(join(root, "doomed.txt"));
  assert.ok(!existsSync(join(root, "doomed.txt")));
  const trashed = readdirSync(trashDir);
  assert.equal(trashed.length, 1);
  assert.ok(trashed[0].endsWith("-doomed.txt"));
  rmSync(root, { recursive: true, force: true });
});
