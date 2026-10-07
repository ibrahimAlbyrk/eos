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
  // A PTY session was created or its metadata (title, Claude conversation id)
  // changed — payload is the full PtySession.
  | "pty:session"
  // A claude pane's transcript changed — clients refetch GET /pty/:id/conversation.
  | "pty:conversation"
  // Ephemeral live reasoning/text deltas (claude, in-process). Relayed to
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
  | "fs:change"
  | "git:change"
  | "update:available"
  // Peering, host side: the set of paired devices connected to this Mac changed
  // (payload { devices: [{ fp, name }] }) — the "… connected" indicator.
  | "peer:presence"
  // Peering, device side: a controlled host was added/removed or its link state
  // changed (payload { id }) — the Machines menu + All machines view refetch.
  | "hosts:change"
  // A page was created, edited or deleted (payload PageChangeEvent) — open
  // editors and page lists refetch.
  | "pages:change"
  // The user's profile changed (payload UserProfileChangeEvent) — Settings ›
  // Profile, the sidebar avatar and the account menu refetch.
  | "profile:change"
  // A memory was suggested, kept, edited, dismissed or deleted (payload
  // UserMemoryChangeEvent) — the Memory view and the pending badge refetch.
  | "user-memory:change"
  // A dream started, moved on, or finished (payload DreamChangeEvent) — the
  // Memory view, Settings › Dreaming and the dream log refetch its status.
  | "dream:change"
  // Sync's status changed (payload SyncStatusResponse) — Settings › Sync refetches
  // nothing, it renders the payload.
  | "sync:change"
  // A file transfer between Macs moved on, or finished ones were cleared
  // (payload TransferChangeEvent) — the Transfer tab renders the payload.
  | "transfer:change"
  // The dashboard's changed worker/pending rows after a burst of the topics
  // above (payload { changes: RowChange[] }, manager/remote/patcher.ts) — tabs
  // merge them instead of re-reading the lists.
  | "state:patch";

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
