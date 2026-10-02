import { describe, it, expect } from "vitest";
import { publishSubagents } from "./subagentsStore.js";
import { confirmSubagentStop, answerSubagentStop } from "./subagentStopConfirm.js";
import { subagentStopMessage } from "../views/agents/center/SubagentStopDialog.jsx";

describe("confirmSubagentStop", () => {
  it("goes ahead at once when no subagent is running", async () => {
    publishSubagents("w-idle", [{ toolUseId: "a", status: "completed" }]);
    await expect(confirmSubagentStop("w-idle", "rewind")).resolves.toBe(true);
  });

  it("waits for the answer while subagents are running", async () => {
    publishSubagents("w-busy", [{ toolUseId: "a", status: "running" }, { toolUseId: "b", status: "running" }]);
    const yes = confirmSubagentStop("w-busy", "compact");
    answerSubagentStop(true);
    await expect(yes).resolves.toBe(true);
    const no = confirmSubagentStop("w-busy", "rewind");
    answerSubagentStop(false);
    await expect(no).resolves.toBe(false);
  });
});

describe("subagentStopMessage", () => {
  it("names how many subagents the action stops", () => {
    expect(subagentStopMessage({ action: "rewind", count: 1 }))
      .toBe("1 subagent is still running. Rewinding restarts the session and stops it.");
    expect(subagentStopMessage({ action: "compact", count: 3 }))
      .toBe("3 subagents are still running. Compacting restarts the session and stops them.");
  });
});
