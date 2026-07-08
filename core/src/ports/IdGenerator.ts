// IdGenerator port — every kind of id (worker, orchestrator, pending,
// request) flows through one of these methods. Real impl uses Math.random;
// tests can inject a deterministic counter.

export interface IdGenerator {
  newWorkerId(): string;
  newOrchestratorId(): string;
  newPendingId(): string;
  newRequestId(): string;
  newLoopId(): string;
  // Durable in-process session id (the source the daemon persists so an API-lane
  // worker can resume across a restart). Added now; consumed by M3 durability.
  newSessionId(): string;
  newScheduledPromptId(): string;
}
