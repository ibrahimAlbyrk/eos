// EventBus — in-process pub/sub. Decouples event producers (use-cases) from
// consumers (SSE broadcaster, metrics collector, usage aggregator). Adapter
// is InMemoryEventBus in infra/eventbus/.

export type EventBusTopic =
  | "worker:change"
  | "worker:spawn"
  | "worker:exit"
  | "worker:removed"
  | "policy:decision"
  | "pending:created"
  | "pending:resolved"
  | "pending:ttl_expired"
  | "usage:recorded"
  | "worker:report"
  | "notification:fire"
  | "terminal:chunk"
  | "terminal:done"
  // Ephemeral live reasoning/text deltas (claude-sdk, in-process). Relayed to
  // SSE like terminal:chunk; never persisted, never drives worker state.
  | "agent:delta"
  | "fs:change"
  | "git:change"
  | "update:available";

export interface EventBusMessage<T = unknown> {
  topic: EventBusTopic;
  payload: T;
  ts: number;
}

export type EventBusSubscriber = (msg: EventBusMessage) => void;

export interface EventBus {
  publish(topic: EventBusTopic, payload: unknown): void;
  subscribe(topic: EventBusTopic | "*", fn: EventBusSubscriber): () => void;
}
