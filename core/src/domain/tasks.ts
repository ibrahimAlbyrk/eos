// Task folding — the one place that knows how a backend's task-list tool calls
// build the canonical Task[] snapshot persisted on workers.tasks. Two shapes
// are recognized; adding a backend's task tool is one more case here, with no
// change to the reducer, persistence, or UI (OCP):
//   - TodoWrite  — one call carries the WHOLE list (a snapshot replace).
//   - TaskCreate/TaskUpdate — incremental: create appends (born "pending",
//     monotonic id = creation order), update mutates by taskId. Deleted tasks
//     are tombstoned (kept in place) so array-position ↔ taskId stays aligned.

import { TaskSchema, TaskStatusSchema, type Task } from "../../../contracts/src/task.ts";

// Parse the stored JSON snapshot back into Task[]. Defensive: malformed/absent
// payloads yield [] so a bad row can never throw inside the reducer.
export function parseStoredTasks(json: string | null | undefined): Task[] {
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((t): t is Task => TaskSchema.safeParse(t).success);
}

function isStatus(v: unknown): v is Task["status"] {
  return TaskStatusSchema.safeParse(v).success;
}

// Returns the new full task snapshot after applying a task-list tool call, or
// null when `name` is not a task-list tool (the caller then leaves tasks
// untouched). `prev` is the current snapshot (from parseStoredTasks).
export function applyTaskTool(prev: Task[], name: string, input: unknown): Task[] | null {
  const inp = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    // Snapshot replace — the whole list arrives in one call.
    case "TodoWrite": {
      if (!Array.isArray(inp.todos)) return null;
      const out: Task[] = [];
      for (const raw of inp.todos) {
        const parsed = TaskSchema.safeParse(raw);
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    }
    // Append a new task (born pending); its array index becomes its taskId-1.
    case "TaskCreate": {
      if (typeof inp.subject !== "string") return prev;
      const task: Task = { content: inp.subject, status: "pending" };
      if (typeof inp.activeForm === "string") task.activeForm = inp.activeForm;
      return [...prev, task];
    }
    // Mutate the task at taskId-1 (ids are 1-based, assigned in creation order).
    case "TaskUpdate": {
      const idx = Number(inp.taskId) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= prev.length) return prev;
      const next = prev.slice();
      const task: Task = { ...next[idx] };
      if (inp.status === "deleted") task.deleted = true;
      else if (isStatus(inp.status)) task.status = inp.status;
      if (typeof inp.subject === "string") task.content = inp.subject;
      if (typeof inp.activeForm === "string") task.activeForm = inp.activeForm;
      next[idx] = task;
      return next;
    }
    default:
      return null;
  }
}
