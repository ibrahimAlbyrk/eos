// Task — one item of an agent's task list (Claude Code's TodoWrite). The
// daemon stamps a JSON snapshot of these on workers.tasks; the web TaskTray
// reads it. Backend-neutral by shape: any backend whose task tool maps to
// {content, status, activeForm} reuses this without change.

import { z } from "zod";

export const TaskStatusSchema = z.enum(["pending", "in_progress", "completed"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  // Imperative form shown in the list ("Run the tests").
  content: z.string(),
  status: TaskStatusSchema,
  // Present-continuous form shown while the task is active ("Running the
  // tests"). Optional — older/other backends omit it (undefined), and the
  // SQL backfill stores an explicit null when a TaskCreate had none.
  activeForm: z.string().nullable().optional(),
  // Tombstone. The TaskCreate/TaskUpdate system assigns monotonic ids by
  // creation order, so a deleted task is kept in the array (not spliced) to
  // keep array-position ↔ taskId aligned for later updates. Filtered out of
  // the displayed list.
  deleted: z.boolean().optional(),
});
export type Task = z.infer<typeof TaskSchema>;
