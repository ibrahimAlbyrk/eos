import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyTier } from "../tiers.ts";

describe("classifyTier (§8)", () => {
  it("classifies reads, low, high, and ✦ ui-token routes", () => {
    assert.deepEqual(classifyTier("GET", "/workers"), { tier: "READ", uiToken: false });
    assert.deepEqual(classifyTier("GET", "/workers/abc/events"), { tier: "READ", uiToken: false });
    assert.deepEqual(classifyTier("POST", "/workers/abc/message"), { tier: "LOW", uiToken: false });
    assert.deepEqual(classifyTier("DELETE", "/workers/abc"), { tier: "HIGH", uiToken: false });
    assert.deepEqual(classifyTier("POST", "/pending/p1/decision"), { tier: "HIGH", uiToken: false });
    assert.deepEqual(classifyTier("POST", "/workers/abc/terminal"), { tier: "HIGH", uiToken: true });
    assert.deepEqual(classifyTier("POST", "/fs/write"), { tier: "HIGH", uiToken: true });
  });

  it("REFUSES the worker-ingest plane and raw/picker surfaces (fail closed)", () => {
    for (const [m, p] of [
      ["POST", "/workers/abc/events"], ["POST", "/policy/decide"],
      ["POST", "/workers/abc/peer-request"], ["POST", "/workers/abc/report"],
      ["POST", "/workers/abc/keystroke"], ["GET", "/stream"], ["GET", "/fs/raw"],
      ["GET", "/pick-file"],
    ] as const) {
      assert.equal(classifyTier(m, p).tier, "REFUSED", `${m} ${p}`);
    }
  });

  it("classifies on the path portion, ignoring the query string (§4.2)", () => {
    assert.deepEqual(classifyTier("GET", "/fs/read?path=/a/b.txt"), { tier: "READ", uiToken: false });
    assert.deepEqual(classifyTier("GET", "/workers/abc/changes/file?p=x&y=1"), { tier: "READ", uiToken: false });
  });

  it("fails closed to REFUSED for unknown routes and wrong methods", () => {
    assert.equal(classifyTier("GET", "/nope/nope").tier, "REFUSED");
    assert.equal(classifyTier("POST", "/workers").tier, "HIGH"); // spawn is HIGH...
    assert.equal(classifyTier("DELETE", "/workers").tier, "REFUSED"); // ...but DELETE /workers is undefined
    assert.equal(classifyTier("GET", "/workers/abc/message").tier, "REFUSED"); // method mismatch
  });
});
