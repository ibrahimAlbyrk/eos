import { describe, it, expect } from "vitest";
import { pickerLocked } from "./composerPickerLock.js";

describe("pickerLocked", () => {
  it("stays unlocked in the new-spawn composer (no worker selected)", () => {
    expect(pickerLocked(null)).toBe(false);
    expect(pickerLocked(undefined)).toBe(false);
  });

  it("locks once a conversation has started (a worker is selected)", () => {
    expect(pickerLocked({ id: "w1", backend_kind: "openai" })).toBe(true);
  });
});
