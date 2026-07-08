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
  // Interactive multi-tab PTY output/exit (the `pty` feature; NOT terminal:*).
  // Relayed to SSE like terminal:chunk; never persisted, never drives worker
  // state. pty:data is batched (200ms/8KB); the client dedups by seq.
  | "pty:data"
  | "pty:exit"
  // Ephemeral live reasoning/text deltas (claude-sdk, in-process). Relayed to
  // SSE like terminal:chunk; never persisted, never drives worker state.
  | "agent:delta"
  // A recalled (interrupt-before-response) message's text + key, pushed to SSE so
  // the UI restores the composer + retracts the optimistic bubble. The durable
  // hide rides the message_recalled event (worker:change); this is the ephemeral
  // client-side restore signal. Never drives worker state.
  | "message:recalled"
  // Dynamic-loop lifecycle (attach / status change / attempt / held). Published
  // from the manager (GoalLoopService + the loop/report routes); rebroadcast to
  // SSE by the "*" subscription. Never drives worker state.
  | "loop:change"
  // Transient goal-check progress (started → verifying|judging → verdict) during
  // a loop tick. Published from GoalLoopService's LoopProgressSink; rebroadcast to
  // SSE by the "*" subscription (the loop:change model). Never persisted, never
  // drives worker state — the durable record is the "loop_check" timeline event.
  | "loop:check"
  // Workflow-orchestration run/step lifecycle. Published from the manager
  // (WorkflowService via the ProgressSink adapter); rebroadcast to SSE by the
  // "*" subscription (the loop:change model). Never drives worker state.
  | "workflow:run-change"
  | "workflow:step-change"
  // A workflow step-worker's typed output (workflow_step_output tool → the
  // /workers/:id/step-output route). The SOLE settle channel for a workflow
  // step's join (WorkerSpawnAdapter.onStepOutput); carries the typed output +
  // status + held flag. Never drives worker state.
  | "workflow:step-output"
  | "fs:change"
  | "git:change"
  // Scheduled-prompt lifecycle. Published from the manager (create/cancel routes
  // + the SchedulerService onFired wiring) ALONGSIDE the persisted timeline
  // event, so the wildcard SSE subscription relays it as its own reason and the
  // web's scheduled list auto-refreshes. Never drives worker state.
  | "scheduled_prompt:created"
  | "scheduled_prompt:fired"
  | "scheduled_prompt:cancelled"
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
