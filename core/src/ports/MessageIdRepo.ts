// Per-worker message id counter. Every message delivered to an agent takes the
// next inbound id ("14"); each assistant text block after it takes
// "<inbound>.<n>" ("14.1", "14.2"). Monotonic for the worker's whole life — a
// /clear, rewind or compaction never resets it, so an id is never reused.
// Adapter is SqliteMessageIdRepo in infra/persistence/.
export interface MessageIdRepo {
  nextInbound(workerId: string): number;
  nextAssistant(workerId: string): string;
  deleteByWorker(workerId: string): void;
}
