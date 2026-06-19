// WorkerToolScopeResolver — the gate's per-worker tool-scope lookup. Flat (no
// parent climb): unlike permission mode, a worker's tool scope is baked at spawn
// and session-immutable, so there is nothing to climb to. null ⇒ no restriction.

import type { ToolScope } from "../../../contracts/src/worker-type.ts";

export interface WorkerToolScopeResolver {
  resolveFor(workerId: string): ToolScope | null;
}
