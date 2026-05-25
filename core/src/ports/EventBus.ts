// EventBus — in-process pub/sub. Decouples event producers (use-cases) from
// consumers (SSE broadcaster, metrics collector, usage aggregator, limit
// enforcer). Adapter is InMemoryEventBus in infra/eventbus/.

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
  | "limit:exceeded"
  | "worker:report"
  | "notification:fire";

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
