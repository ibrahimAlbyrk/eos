import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomOrchestratorName, promptSnippetName } from "../names.ts";

describe("randomOrchestratorName", () => {
  it("is '<adjective>-<3 digits>' with no role suffix", () => {
    for (let i = 0; i < 50; i++) assert.match(randomOrchestratorName(), /^[a-z]+-\d{3}$/);
  });
});

describe("promptSnippetName", () => {
  it("keeps a short prompt whole, whitespace collapsed", () => {
    assert.equal(promptSnippetName("  fix the\n\nsidebar   name  "), "fix the sidebar name");
  });

  it("cuts a long prompt to 40 chars plus an ellipsis", () => {
    const name = promptSnippetName("eosda ilk mesaji gonderinde sol panelde session ismi rastgele oluyor");
    assert.equal(name, "eosda ilk mesaji gonderinde sol panelde…");
  });

  it("never splits an emoji", () => {
    assert.equal(promptSnippetName(`${"a".repeat(39)}😀😀`), `${"a".repeat(39)}😀…`);
  });

  it("is null for an empty prompt", () => {
    assert.equal(promptSnippetName(" \n "), null);
  });
});
