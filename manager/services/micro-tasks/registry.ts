// Micro-task registry — the single place that assembles the MicroTask[] the
// runner subscribes. Adding a task is one entry here (open/closed). Auto-name is
// the only one today; future tasks take the same AutoNameDeps-style bundle.

import type { MicroTask } from "../../../core/src/ports/MicroTask.ts";
import { makeAutoNameTask, type AutoNameDeps } from "./autoName.ts";

export function buildMicroTasks(deps: AutoNameDeps): MicroTask[] {
  return [makeAutoNameTask(deps)];
}
