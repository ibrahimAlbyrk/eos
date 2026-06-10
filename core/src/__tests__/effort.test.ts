import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveEffort } from "../domain/effort.ts";

const ALL = ["low", "medium", "high", "xhigh", "max"];

describe("resolveEffort", () => {
  it("returns undefined when nothing requested", () => {
    assert.equal(resolveEffort(undefined, ALL), undefined);
    assert.equal(resolveEffort(undefined, null), undefined);
  });

  it("passes non-API levels through untouched (CLI is the authority)", () => {
    assert.equal(resolveEffort("ultracode", ALL), "ultracode");
    assert.equal(resolveEffort("auto", []), "auto");
  });

  it("fails open when capability is unknown", () => {
    assert.equal(resolveEffort("xhigh", null), "xhigh");
  });

  it("keeps a supported level", () => {
    assert.equal(resolveEffort("medium", ALL), "medium");
    assert.equal(resolveEffort("max", ["low", "max"]), "max");
  });

  it("drops effort for models without any support", () => {
    assert.equal(resolveEffort("xhigh", []), undefined);
    assert.equal(resolveEffort("low", []), undefined);
  });

  it("clamps down to the nearest supported level", () => {
    assert.equal(resolveEffort("xhigh", ["low", "medium", "high", "max"]), "high");
    assert.equal(resolveEffort("max", ["low", "medium"]), "medium");
  });

  it("clamps up when nothing below is supported", () => {
    assert.equal(resolveEffort("low", ["medium", "high"]), "medium");
  });

  it("drops when no API level overlaps", () => {
    assert.equal(resolveEffort("high", ["weird"]), undefined);
  });
});
