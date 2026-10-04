// Dream runs, per-chat watermarks and the chats the user turned off — a
// regenerable log (state.db); losing it only means the next dream rereads chats.

import type { DreamRun } from "../../../contracts/src/dream.ts";

export interface DreamRepo {
  // Insert or replace a run (a running row first, the finished one after).
  save(run: DreamRun): void;
  get(id: string): DreamRun | null;
  // Newest first.
  list(limit: number): DreamRun[];
  latest(): DreamRun | null;
  // The last event id a dream read in this chat (0 = never read).
  watermark(workerId: string): number;
  setWatermark(workerId: string, eventId: number): void;
  excluded(): string[];
  setExcluded(workerId: string, excluded: boolean): void;
}
