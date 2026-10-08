// Dream runs, per-chat watermarks, the chats the user turned off and the candidate
// ledger — a regenerable log (state.db); losing it only means the next dream rereads
// chats and candidates gather support again.

import type { DreamCandidate, DreamRun } from "../../../contracts/src/dream.ts";

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
  candidates(): DreamCandidate[];
  // The whole ledger after a dream, in one write.
  replaceCandidates(candidates: readonly DreamCandidate[]): void;
}
