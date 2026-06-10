import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { contentTypeFor } from "../mime.ts";

describe("contentTypeFor", () => {
  it("maps known extensions case-insensitively", () => {
    assert.equal(contentTypeFor("/a/b/Doc.PDF"), "application/pdf");
    assert.equal(contentTypeFor("/a/game.html"), "text/html; charset=utf-8");
    assert.equal(contentTypeFor("/a/mod.wasm"), "application/wasm");
    assert.equal(contentTypeFor("/a/clip.mov"), "video/quicktime");
  });

  it("falls back to octet-stream", () => {
    assert.equal(contentTypeFor("/a/data.bcmap"), "application/octet-stream");
    assert.equal(contentTypeFor("/a/noext"), "application/octet-stream");
  });
});
