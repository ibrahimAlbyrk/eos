import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyTaskTool, parseStoredTasks } from "../domain/tasks.ts";
import type { Task } from "../../../contracts/src/task.ts";

describe("parseStoredTasks", () => {
  it("returns [] for null / malformed / non-array", () => {
    assert.deepEqual(parseStoredTasks(null), []);
    assert.deepEqual(parseStoredTasks("{not json"), []);
    assert.deepEqual(parseStoredTasks('"a string"'), []);
  });

  it("keeps valid task objects and drops invalid ones", () => {
    const json = JSON.stringify([
      { content: "ok", status: "pending" },
      { content: "bad", status: "frozen" },
      { status: "pending" },
    ]);
    assert.deepEqual(parseStoredTasks(json), [{ content: "ok", status: "pending" }]);
  });
});

describe("applyTaskTool — non-task tools", () => {
  it("returns null for an unrelated tool", () => {
    assert.equal(applyTaskTool([], "Bash", { command: "ls" }), null);
  });
});

describe("applyTaskTool — TodoWrite (snapshot replace)", () => {
  it("replaces the whole list, ignoring prev", () => {
    const prev: Task[] = [{ content: "old", status: "completed" }];
    const out = applyTaskTool(prev, "TodoWrite", {
      todos: [
        { content: "A", status: "in_progress", activeForm: "Doing A" },
        { content: "B", status: "pending" },
      ],
    });
    assert.deepEqual(out, [
      { content: "A", status: "in_progress", activeForm: "Doing A" },
      { content: "B", status: "pending" },
    ]);
  });

  it("returns null when todos is missing", () => {
    assert.equal(applyTaskTool([], "TodoWrite", {}), null);
  });
});

describe("applyTaskTool — TaskCreate/TaskUpdate (incremental fold)", () => {
  it("appends a pending task on create", () => {
    const out = applyTaskTool([], "TaskCreate", { subject: "First", activeForm: "Doing first" });
    assert.deepEqual(out, [{ content: "First", status: "pending", activeForm: "Doing first" }]);
  });

  it("accumulates across creates", () => {
    let tasks: Task[] = [];
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "A" })!;
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "B" })!;
    assert.deepEqual(tasks.map((t) => t.content), ["A", "B"]);
  });

  it("updates status by taskId (1-based position)", () => {
    let tasks: Task[] = [];
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "A" })!;
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "B" })!;
    tasks = applyTaskTool(tasks, "TaskUpdate", { taskId: "2", status: "in_progress" })!;
    assert.equal(tasks[1].status, "in_progress");
    assert.equal(tasks[0].status, "pending");
  });

  it("tombstones a deleted task in place, keeping later ids aligned", () => {
    let tasks: Task[] = [];
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "A" })!;
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "B" })!;
    tasks = applyTaskTool(tasks, "TaskUpdate", { taskId: "1", status: "deleted" })!;
    // A is tombstoned but kept, so the next create still lands at index 2 (#3).
    tasks = applyTaskTool(tasks, "TaskCreate", { subject: "C" })!;
    assert.equal(tasks[0].deleted, true);
    assert.equal(tasks.length, 3);
    // Updating #3 must hit C, not be thrown off by the tombstone.
    tasks = applyTaskTool(tasks, "TaskUpdate", { taskId: "3", status: "completed" })!;
    assert.equal(tasks[2].content, "C");
    assert.equal(tasks[2].status, "completed");
  });

  it("ignores an out-of-range taskId (returns prev unchanged)", () => {
    const prev: Task[] = [{ content: "A", status: "pending" }];
    assert.deepEqual(applyTaskTool(prev, "TaskUpdate", { taskId: "9", status: "completed" }), prev);
  });

  it("can rename via subject and set activeForm on update", () => {
    let tasks: Task[] = [{ content: "old", status: "pending" }];
    tasks = applyTaskTool(tasks, "TaskUpdate", { taskId: "1", subject: "new", activeForm: "Newing" })!;
    assert.deepEqual(tasks[0], { content: "new", status: "pending", activeForm: "Newing" });
  });
});
