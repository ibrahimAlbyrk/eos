import { describe, it, expect } from "vitest";
import { pickerLocked, modelPickerLocked } from "./composerPickerLock.js";

describe("pickerLocked", () => {
  it("stays unlocked in the new-spawn composer (no worker selected)", () => {
    expect(pickerLocked(null)).toBe(false);
    expect(pickerLocked(undefined)).toBe(false);
  });

  it("locks once a conversation has started (a worker is selected)", () => {
    expect(pickerLocked({ id: "w1", backend_kind: "openai" })).toBe(true);
  });
});

describe("modelPickerLocked", () => {
  const w = { id: "w1", backend_kind: "claude-sdk" };

  it("stays unlocked in the new-spawn composer regardless of capability", () => {
    expect(modelPickerLocked(null, false)).toBe(false);
    expect(modelPickerLocked(undefined, true)).toBe(false);
  });

  it("unlocks a selected worker whose backend can switch model at runtime", () => {
    expect(modelPickerLocked(w, true)).toBe(false);
  });

  it("stays locked for a selected worker whose backend cannot switch model", () => {
    expect(modelPickerLocked(w, false)).toBe(true);
  });
});
