import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/notify.js", () => ({ notify: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

import { notify } from "../lib/notify.js";
import { canStopSubagent, isStoppingSubagent, stopSubagent } from "./subagentStopStore.js";

const run = (over = {}) => ({ toolUseId: "toolu_a", status: "running", background: true, subagentType: "general-purpose", ...over });

describe("canStopSubagent", () => {
  it("is for a working background subagent only", () => {
    expect(canStopSubagent(run())).toBe(true);
    expect(canStopSubagent(run({ status: "completed" }))).toBe(false);
    expect(canStopSubagent(run({ status: "stopped" }))).toBe(false);
    expect(canStopSubagent(run({ background: false }))).toBe(false);
    expect(canStopSubagent(run({ subagentType: "workflow-subagent" }))).toBe(false);
    expect(canStopSubagent(null)).toBe(false);
  });
});

describe("stopSubagent", () => {
  beforeEach(() => notify.error.mockClear());

  it("stays stopping once the core took it, by the latest run's call", async () => {
    const request = vi.fn(async () => ({ ok: true, status: 200, body: { ok: true } }));
    const resumed = run({ toolUseId: "toolu_first", runs: [{ toolUseId: "toolu_first" }, { toolUseId: "toolu_send" }] });
    expect(await stopSubagent("w1", resumed, request)).toBe("stopping");
    expect(request).toHaveBeenCalledWith("w1", "toolu_send");
    expect(isStoppingSubagent("w1", resumed)).toBe(true);
    // A second click while it stops asks nothing more.
    expect(await stopSubagent("w1", resumed, request)).toBe("stopping");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("takes one that had already ended quietly", async () => {
    const request = async () => ({ ok: false, status: 409, body: { error: "Task a is not running", code: "subagent_ended" } });
    const ended = run({ toolUseId: "toolu_ended" });
    expect(await stopSubagent("w1", ended, request)).toBe("ended");
    expect(isStoppingSubagent("w1", ended)).toBe(false);
    expect(notify.error).not.toHaveBeenCalled();
  });

  it("tells the user when the stop fails", async () => {
    const failing = run({ toolUseId: "toolu_fail" });
    expect(await stopSubagent("w1", failing, async () => ({ ok: false, status: 404, body: { error: "no subagent with that call id" } }))).toBe("failed");
    expect(isStoppingSubagent("w1", failing)).toBe(false);
    expect(notify.error).toHaveBeenCalledWith("Couldn't stop the subagent: no subagent with that call id");
    expect(await stopSubagent("w1", failing, async () => { throw new Error("offline"); })).toBe("failed");
    expect(notify.error).toHaveBeenLastCalledWith("Couldn't stop the subagent: offline");
  });
});
