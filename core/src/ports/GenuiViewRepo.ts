// Visual answers the agents presented (state.db, migration 064). Regenerable: a
// wipe only loses old views' rendering — their text summaries stay in the log.

import type { ViewRecord, ViewState } from "../../../contracts/src/genui/spec.ts";

export interface StoredViewState {
  readonly state: ViewState;
  readonly updatedAt: number;
}

export interface GenuiViewRepo {
  save(view: ViewRecord): void;
  get(id: string): ViewRecord | null;
  // Per-instance UI state (filters, ticks, the current step); null = never set.
  getState(id: string): StoredViewState | null;
  putState(id: string, state: ViewState, at: number): void;
  // Drops a removed worker's views and their state.
  removeByWorker(workerId: string): void;
}
