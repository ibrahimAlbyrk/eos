// IdGenerator port — every kind of id (worker, orchestrator, pending,
// request) flows through one of these methods. Real impl uses Math.random;
// tests can inject a deterministic counter.

export interface IdGenerator {
  newWorkerId(): string;
  newOrchestratorId(): string;
  newPendingId(): string;
  newRequestId(): string;
  newLoopId(): string;
}
