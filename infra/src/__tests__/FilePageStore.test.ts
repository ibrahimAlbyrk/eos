import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FilePageStore, parsePage, serializePage } from "../persistence/FilePageStore.ts";
import type { Page } from "../../../contracts/src/http.ts";

const PAGE: Page = {
  id: "pg-abc12345",
  title: "Stance: notes — \"quoted\"",
  body: "---\nnot frontmatter\n---\n\n- [ ] task\n",
  project: "/Users/me/dear-souls",
  agentId: null,
  rev: 3,
  createdAt: 1,
  updatedAt: 2,
  updatedBy: { kind: "agent", agentId: "w-1", name: "Stance IK" },
};

describe("FilePageStore", () => {
  it("round-trips a page through its markdown file, body verbatim", () => {
    assert.deepEqual(parsePage(serializePage(PAGE)), PAGE);
  });

  it("persists, reloads, and soft-deletes to .trash", () => {
    const dir = mkdtempSync(join(tmpdir(), "pages-"));
    const store = new FilePageStore(dir);
    store.put(PAGE);
    assert.ok(readFileSync(join(dir, "pg-abc12345.md"), "utf8").includes("- [ ] task"));

    const reloaded = new FilePageStore(dir);
    assert.deepEqual(reloaded.get(PAGE.id), PAGE);

    assert.equal(reloaded.remove(PAGE.id), true);
    assert.equal(reloaded.get(PAGE.id), null);
    assert.equal(readdirSync(join(dir, ".trash")).length, 1);
    assert.equal(new FilePageStore(dir).list().length, 0);
  });

  it("skips unparseable files and refuses a bad id", () => {
    const dir = mkdtempSync(join(tmpdir(), "pages-"));
    writeFileSync(join(dir, "pg-zzzzzzzz.md"), "no frontmatter");
    assert.equal(new FilePageStore(dir).list().length, 0);
    assert.throws(() => new FilePageStore(dir).put({ ...PAGE, id: "../escape" }));
  });
});
