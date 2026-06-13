import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FilePromptSource } from "../prompt/FilePromptSource.ts";

describe("FilePromptSource", () => {
  it("reads nested prompts, derives id from path, parses frontmatter, applies override precedence", () => {
    const builtin = mkdtempSync(join(tmpdir(), "eos-prompts-builtin-"));
    const user = mkdtempSync(join(tmpdir(), "eos-prompts-user-"));
    try {
      mkdirSync(join(builtin, "tone"), { recursive: true });
      writeFileSync(
        join(builtin, "tone", "concise.prompt.md"),
        "---\ndescription: be brief\nvariables:\n  - name: agentName\n---\nYou are {{agentName}}.\n",
      );
      writeFileSync(join(builtin, "greeting.prompt.md"), "hello from builtin");
      // user dir provides the same id → it wins
      writeFileSync(join(user, "greeting.prompt.md"), "hello from user");

      const all = new FilePromptSource([builtin, user]).list();
      const byId = new Map(all.map((p) => [p.id, p]));

      assert.ok(byId.has("tone/concise"));
      const concise = byId.get("tone/concise");
      assert.equal((concise?.frontmatter as { description?: string }).description, "be brief");
      assert.match(concise?.body ?? "", /You are \{\{agentName\}\}\./);

      assert.equal(byId.get("greeting")?.body.trim(), "hello from user");
    } finally {
      rmSync(builtin, { recursive: true, force: true });
      rmSync(user, { recursive: true, force: true });
    }
  });

  it("returns nothing for a missing directory", () => {
    const src = new FilePromptSource([join(tmpdir(), "eos-prompts-does-not-exist-xyz")]);
    assert.deepEqual(src.list(), []);
  });
});
