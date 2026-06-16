import { describe, it, expect } from "vitest";
import { parseWorkerTasks } from "./workerTasks.js";

describe("parseWorkerTasks", () => {
  it("returns [] when the worker has no tasks", () => {
    expect(parseWorkerTasks(null)).toEqual([]);
    expect(parseWorkerTasks({})).toEqual([]);
    expect(parseWorkerTasks({ tasks: null })).toEqual([]);
  });

  it("returns [] for malformed JSON", () => {
    expect(parseWorkerTasks({ tasks: "{not json" })).toEqual([]);
    expect(parseWorkerTasks({ tasks: '"a string"' })).toEqual([]);
  });

  it("parses a valid snapshot", () => {
    const tasks = JSON.stringify([
      { content: "A", status: "completed", activeForm: "Doing A" },
      { content: "B", status: "in_progress" },
    ]);
    expect(parseWorkerTasks({ tasks })).toEqual([
      { content: "A", status: "completed", activeForm: "Doing A" },
      { content: "B", status: "in_progress" },
    ]);
  });

  it("filters items with an unknown status or missing content", () => {
    const tasks = JSON.stringify([
      { content: "ok", status: "pending" },
      { content: "bad", status: "frozen" },
      { status: "pending" },
      null,
    ]);
    expect(parseWorkerTasks({ tasks })).toEqual([{ content: "ok", status: "pending" }]);
  });

  it("hides tombstoned (deleted) tasks", () => {
    const tasks = JSON.stringify([
      { content: "kept", status: "pending" },
      { content: "gone", status: "pending", deleted: true },
    ]);
    expect(parseWorkerTasks({ tasks })).toEqual([{ content: "kept", status: "pending" }]);
  });
});
