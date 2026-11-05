// EventBus — in-process pub/sub. Decouples event producers (use-cases) from
// consumers (SSE broadcaster, metrics collector, usage aggregator). Adapter
// is InMemoryEventBus in infra/eventbus/.

// Every bus topic, as keys. The kernel's are listed here; a feature module adds
// its own where it lives:
//   declare module "<path>/core/src/ports/EventBus.ts" { interface EventBusTopics { "x:change": true } }
// A plugin's own events ride plugin:<id>:<event>.
export interface EventBusTopics {
  "worker:change": true;
  "worker:spawn": true;
  "worker:exit": true;
  "worker:removed": true;
  "policy:decision": true;
  "pending:created": true;
  "pending:resolved": true;
  "pending:ttl_expired": true;
  "usage:recorded": true;
  "worker:report": true;
  "notification:fire": true;
  // A `!` command started (payload { workerId|null, runId, command, startedAt }).
  "terminal:start": true;
  "terminal:chunk": true;
  "terminal:done": true;
  // Interactive multi-tab PTY output/exit (the `pty` feature; NOT terminal:*).
  // Relayed to SSE like terminal:chunk; never persisted, never drives worker
  // state. pty:data is batched (200ms/8KB); the client dedups by seq.
  "pty:data": true;
  "pty:exit": true;
  // A PTY session was created or its metadata (title, Claude conversation id)
  // changed — payload is the full PtySession.
  "pty:session": true;
  // A claude pane's transcript changed — clients refetch GET /pty/:id/conversation.
  "pty:conversation": true;
  // Ephemeral live reasoning/text deltas (claude, in-process). Relayed to
  // SSE like terminal:chunk; never persisted, never drives worker state.
  "agent:delta": true;
  // A recalled (interrupt-before-response) message's text + key, pushed to SSE so
  // the UI restores the composer + retracts the optimistic bubble. The durable
  // hide rides the message_recalled event (worker:change); this is the ephemeral
  // client-side restore signal. Never drives worker state.
  "message:recalled": true;
  // Dynamic-loop lifecycle (attach / status change / attempt / held). Published
  // from the manager (GoalLoopService + the loop/report routes); rebroadcast to
  // SSE by the "*" subscription. Never drives worker state.
  "loop:change": true;
  // Transient goal-check progress (started → verifying|judging → verdict) during
  // a loop tick. Published from GoalLoopService's LoopProgressSink; rebroadcast to
  // SSE by the "*" subscription (the loop:change model). Never persisted, never
  // drives worker state — the durable record is the "loop_check" timeline event.
  "loop:check": true;
  "fs:change": true;
  "git:change": true;
  // Peering, host side: the set of paired devices connected to this Mac changed
  // (payload { devices: [{ fp, name }] }) — the "… connected" indicator.
  "peer:presence": true;
  // Peering, device side: a controlled host was added/removed or its link state
  // changed (payload { id }) — the Machines menu + All machines view refetch.
  "hosts:change": true;
  // A page was created, edited or deleted (payload PageChangeEvent) — open
  // editors and page lists refetch.
  "pages:change": true;
  // The user's profile changed (payload UserProfileChangeEvent) — Settings ›
  // Profile, the sidebar avatar and the account menu refetch.
  "profile:change": true;
  // A memory was suggested, kept, edited, dismissed or deleted (payload
  // UserMemoryChangeEvent) — the Memory view and the pending badge refetch.
  "user-memory:change": true;
  // Subscription usage after an upstream round-trip (payload UsageResponse) —
  // the account menu and Settings › Usage render the payload.
  "usage:change": true;
  // A background job started, moved on or ended, or finished ones were dropped
  // (payload BackgroundJobChange) — the header beacon and the Jobs tab.
  "jobs:change": true;
  // Plugins (contracts/src/plugin.ts): plugins:change {id} — one was added,
  // removed, rebuilt, toggled or re-set; plugin:<id>:<event> — a plugin's own.
  "plugins:change": true;
  // The dashboard's changed worker/pending rows after a burst of the topics
  // above (payload { changes: RowChange[] }, manager/remote/patcher.ts) — tabs
  // merge them instead of re-reading the lists.
  "state:patch": true;
}

export type EventBusTopic = keyof EventBusTopics | `plugin:${string}`;

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
