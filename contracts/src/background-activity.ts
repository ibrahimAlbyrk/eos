// Live background processes an agent has spawned — the Monitor tool and
// `Bash run_in_background`. Surfaced by the corner activity widget. These are
// runtime view-state (route-enriched onto WorkerRow from the in-memory
// BackgroundActivityService), never a DB column: the processes die with the
// worker, so a fresh empty set is the correct state after any daemon restart.

import { z } from "zod";

export const BackgroundActivityKindSchema = z.enum(["monitor", "bash"]);
export type BackgroundActivityKind = z.infer<typeof BackgroundActivityKindSchema>;

export const BackgroundActivityEntrySchema = z.object({
  kind: BackgroundActivityKindSchema,
  // tool_use id of the spawning call — the widget's stable key.
  toolUseId: z.string().nullable(),
  // What is watched/run: Monitor's `description`, or the bash `command`.
  label: z.string(),
  startedAt: z.number(),
  // Parsed from the "...running in background with ID: <id>" reply, when present.
  shellId: z.string().nullable().optional(),
});
export type BackgroundActivityEntry = z.infer<typeof BackgroundActivityEntrySchema>;
