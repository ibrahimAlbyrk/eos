import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, isAbsolute, dirname } from "node:path";
import { tmpdir } from "node:os";
import { UserTemplateService } from "../UserTemplateService.ts";

describe("UserTemplateService", () => {
  let dir: string;
  let svc: UserTemplateService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tpl-test-"));
    svc = new UserTemplateService(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists empty when dir does not exist", () => {
    const ghost = new UserTemplateService(join(dir, "missing"));
    assert.deepEqual(ghost.list(), []);
  });

  it("write + read roundtrips name, description, content", () => {
    svc.write({ name: "bug-fix", description: "repro & fix", content: "Fix {{file}}.\nRepro: {{steps}}", attachments: [] });
    const t = svc.read("bug-fix");
    assert.equal(t.name, "bug-fix");
    assert.equal(t.description, "repro & fix");
    assert.equal(t.content, "Fix {{file}}.\nRepro: {{steps}}");
    assert.deepEqual(t.attachments, []);
  });

  it("write is an upsert and list sorts by name", () => {
    svc.write({ name: "b", description: "", content: "two", attachments: [] });
    svc.write({ name: "a", description: "", content: "one", attachments: [] });
    svc.write({ name: "b", description: "updated", content: "two-v2", attachments: [] });
    const names = svc.list().map((t) => t.name);
    assert.deepEqual(names, ["a", "b"]);
    assert.equal(svc.read("b").content, "two-v2");
    assert.equal(svc.read("b").description, "updated");
  });

  it("survives yaml-hostile descriptions", () => {
    const desc = `it's: "tricky" #yes`;
    svc.write({ name: "tricky", description: desc, content: "body", attachments: [] });
    assert.equal(svc.read("tricky").description, desc);
  });

  it("reads hand-written files without frontmatter", () => {
    writeFileSync(join(dir, "raw.md"), "just a prompt\n");
    const t = svc.read("raw");
    assert.equal(t.description, "");
    assert.equal(t.content, "just a prompt");
    assert.deepEqual(t.attachments, []);
  });

  it("rejects invalid names", () => {
    assert.throws(() => svc.write({ name: "../escape", description: "", content: "x", attachments: [] }));
    assert.throws(() => svc.read("Has Spaces"));
    assert.throws(() => svc.delete("UPPER"));
  });

  it("delete moves the file to .trash and reports missing", () => {
    svc.write({ name: "gone", description: "", content: "x", attachments: [] });
    assert.equal(svc.delete("gone"), true);
    assert.equal(svc.delete("gone"), false);
    assert.deepEqual(svc.list(), []);
    const trashed = readdirSync(join(dir, ".trash"));
    assert.equal(trashed.length, 1);
    assert.ok(trashed[0].startsWith("gone."));
    assert.ok(trashed[0].endsWith(".md"));
  });

  it("written file is frontmatter + body markdown", () => {
    svc.write({ name: "fmt", description: "d", content: "body", attachments: [] });
    const raw = readFileSync(join(dir, "fmt.md"), "utf8");
    assert.ok(raw.startsWith("---\n"));
    assert.ok(raw.includes("description: d"));
    assert.ok(raw.endsWith("body\n"));
  });

  it("promotes an external attachment into the asset store and resolves it absolute", () => {
    const src = join(dir, "shot.png");
    writeFileSync(src, "PNGBYTES");
    svc.write({
      name: "with-img",
      description: "",
      content: "see [shot.png]",
      attachments: [{ label: "[shot.png]", kind: "image", path: src }],
    });

    // stored frontmatter path is RELATIVE (portable), under assets/<name>/
    const raw = readFileSync(join(dir, "with-img.md"), "utf8");
    assert.ok(raw.includes("assets/with-img/shot.png"));
    assert.ok(!raw.includes(src), "absolute source path must not be persisted");

    // read() resolves to an absolute path that exists with the copied bytes
    const t = svc.read("with-img");
    assert.equal(t.attachments.length, 1);
    assert.equal(t.attachments[0].label, "[shot.png]");
    assert.equal(t.attachments[0].kind, "image");
    assert.ok(isAbsolute(t.attachments[0].path));
    assert.ok(t.attachments[0].path.includes(join("assets", "with-img")));
    assert.equal(readFileSync(t.attachments[0].path, "utf8"), "PNGBYTES");
  });

  it("re-save with the resolved durable path does not re-copy", () => {
    const src = join(dir, "shot.png");
    writeFileSync(src, "A");
    svc.write({ name: "img", description: "", content: "[shot.png]", attachments: [{ label: "[shot.png]", kind: "image", path: src }] });
    const first = svc.read("img").attachments[0].path;
    // feed the resolved absolute path back (what the editor does on edit)
    svc.write({ name: "img", description: "v2", content: "[shot.png]", attachments: [{ label: "[shot.png]", kind: "image", path: first }] });
    const assetFiles = readdirSync(join(dir, "assets", "img"));
    assert.deepEqual(assetFiles, ["shot.png"], "must not accumulate duplicate copies");
    assert.equal(svc.read("img").attachments[0].path, first);
  });

  it("dedupes colliding asset filenames", () => {
    const a = join(dir, "a", "logo.png");
    const b = join(dir, "b", "logo.png");
    writeFileSync(mkpath(a), "A");
    writeFileSync(mkpath(b), "B");
    svc.write({
      name: "dup",
      description: "",
      content: "[logo.png] [logo.png 2]",
      attachments: [
        { label: "[logo.png]", kind: "image", path: a },
        { label: "[logo.png 2]", kind: "image", path: b },
      ],
    });
    const files = readdirSync(join(dir, "assets", "dup")).sort();
    assert.deepEqual(files, ["logo-2.png", "logo.png"]);
  });

  it("keeps a folder reference as-is (no copy)", () => {
    const folder = join(dir, "some-folder");
    writeFileSync(mkpath(join(folder, "x.txt")), "x");
    svc.write({ name: "fld", description: "", content: "[some-folder]", attachments: [{ label: "[some-folder]", kind: "folder", path: folder }] });
    assert.ok(!existsSync(join(dir, "assets", "fld")), "folders are not promoted");
    assert.equal(svc.read("fld").attachments[0].path, folder);
  });

  it("delete soft-trashes the asset dir", () => {
    const src = join(dir, "s.png");
    writeFileSync(src, "x");
    svc.write({ name: "doomed", description: "", content: "[s.png]", attachments: [{ label: "[s.png]", kind: "image", path: src }] });
    assert.ok(existsSync(join(dir, "assets", "doomed")));
    svc.delete("doomed");
    assert.ok(!existsSync(join(dir, "assets", "doomed")), "live asset dir gone");
    const trashedAssets = readdirSync(join(dir, ".trash", "assets"));
    assert.equal(trashedAssets.length, 1);
    assert.ok(trashedAssets[0].startsWith("doomed."));
  });

  it("drops an attachment whose source vanished", () => {
    svc.write({ name: "ghost", description: "", content: "body", attachments: [{ label: "[gone.png]", kind: "image", path: join(dir, "nope.png") }] });
    assert.deepEqual(svc.read("ghost").attachments, []);
  });
});

function mkpath(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  return file;
}
