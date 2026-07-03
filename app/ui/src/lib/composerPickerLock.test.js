import { describe, it, expect } from "vitest";
import { pickerLocked, modelPickerLocked, workerBusy } from "./composerPickerLock.js";

describe("pickerLocked", () => {
  it("stays unlocked in the new-spawn composer (no worker selected)", () => {
    expect(pickerLocked(null)).toBe(false);
    expect(pickerLocked(undefined)).toBe(false);
  });

  it("locks once a conversation has started (a worker is selected)", () => {
    expect(pickerLocked({ id: "w1", backend_kind: "openai" })).toBe(true);
  });
});

describe("workerBusy — the composer pills' busy signal (existing worker state)", () => {
  it("at-rest states (or no worker) are not busy; a turn-in-progress is", () => {
    expect(workerBusy(null)).toBe(false);
    expect(workerBusy(undefined)).toBe(false);
    expect(workerBusy({ state: "IDLE" })).toBe(false);
    expect(workerBusy({ state: "SUSPENDED" })).toBe(false);
    expect(workerBusy({ state: "DONE" })).toBe(false);
    expect(workerBusy({ state: "WORKING" })).toBe(true);
    expect(workerBusy({ state: "SPAWNING" })).toBe(true);
  });
});

describe("modelPickerLocked — locks only while the worker is busy on a turn", () => {
  it("stays open in the new-spawn composer (no worker)", () => {
    expect(modelPickerLocked(null)).toBe(false);
    expect(modelPickerLocked(undefined)).toBe(false);
  });

  it("provider locked but model selectable while IDLE; model locked while WORKING", () => {
    // A DeepSeek worker (in-process, no same-infrastructure switch target) keeps the
    // PROVIDER locked regardless, but the MODEL pill follows the worker's busy state:
    // idle → selectable, working → locked. Provider-lock and model-lock are independent.
    const idle = { id: "w1", backend_kind: "openai", backend_profile: "deepseek", state: "IDLE" };
    const working = { ...idle, state: "WORKING" };
    expect(pickerLocked(idle)).toBe(true); // conversation started → provider lock applies
    expect(modelPickerLocked(idle)).toBe(false); // idle → model selectable
    expect(modelPickerLocked(working)).toBe(true); // working → model locked
  });
});
