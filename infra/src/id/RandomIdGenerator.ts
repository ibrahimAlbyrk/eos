import type { IdGenerator } from "../../../core/src/ports/IdGenerator.ts";

// Random base36 generator. Collision risk negligible at this scale —
// 8 chars of base36 = ~1.6e12 distinct ids per prefix.
function rand(n: number): string {
  return Math.random().toString(36).slice(2, 2 + n);
}

export const randomIdGenerator: IdGenerator = {
  newWorkerId: (): string => "w-" + rand(8),
  newOrchestratorId: (): string => "o-" + rand(6),
  newPendingId: (): string => "p-" + rand(8),
  newRequestId: (): string => "r-" + rand(8),
  newLoopId: (): string => "l-" + rand(8),
  newSessionId: (): string => "s-" + rand(8),
};
