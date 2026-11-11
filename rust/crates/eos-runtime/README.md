# eos-runtime

What a feature sees of the running app. There is no HTTP server: requests arrive as values, tagged
with who is calling, and the router decides from that tag. Everything here is machinery — no
feature logic, no I/O beyond reading a job's output file.

```
shell bridge ─┐                       ┌─ Router ── access rule ── plugin switch ── handler
phone gateway ├── Request{caller} ──▶ │
peer gateway ─┘                       └─ Response{status, headers, Body::{Empty,Bytes,Stream}}

handler / service ── Ordered::run(change + publish) ──▶ Bus ──▶ handlers (in order, on the lane)
                                                         └────▶ StreamHub ── ring ──▶ each stream
```

## A feature in three moves

**Declare a route.** Method, pattern, access rule, handler — the rule is not optional.

```rust
RouteDef::post("/api/notes/{id}/export", move |req: Request| {
    let jobs = jobs.clone();
    async move {
        let id = req.param("id").unwrap_or_default();
        let body: ExportRequest = req.json()?;          // 400 `invalid request: …` on a bad body
        // …
        Ok(Response::json(200, &ExportResponse { /* … */ }))
    }
})
.access(Access::ui_token().phone_user(Tier::Low))        // user's dashboard; phone at LOW; crosses to a paired Mac
```

- Patterns: literal segments, `{name}` (or `:name`, as the contract route table writes it), a
  final `{*rest}`. A literal wins over a parameter; two
  routes of one method and shape are a build error — registration order never matters.
- `Access::open()` any local page · `Access::ui_token()` the user's dashboard only ·
  `.local_only()` never crosses to a paired computer · `.peer_open()` public by design ·
  `.phone(tier)` / `.phone_user(tier)` the phone may call it (the second: the gateway vouches for
  the user). A route with no rule is refused to every caller outside the app and fails the build.
- Errors: return `ApiError::{NotFound, Conflict, Validation, PermissionDenied, LimitExceeded,
  Unreachable, Domain, …}`; `http/error.rs` is the one place they become today's status code and
  `{ "error": … }` body. A handler that panics answers 500 and fails only its request.
- A streamed body: `Body::channel(n)` — `send().await` is the back-pressure, a dropped body (the
  caller went away) makes `send` fail and `closed()` resolve. Files: `file_response` (Range).

**Publish an event.** A topic is a constant with its payload type; the payload is serialized once
and shared by every subscriber and every stream.

```rust
pub const NOTES_CHANGE: Topic<NoteChange> = Topic::new("notes:change");

let bus = kernel.bus.clone();
kernel.ordered.run(move || {            // the change and its event are one lane job
    notes.rename(id, &title);           // in-memory transition
    bus.publish(&NOTES_CHANGE, &NoteChange { id, title });
}).await?;
```

React with `bus.on(&TOPIC, |event| …)` (runs on the lane, must not block) or read at your own
pace with `bus.subscribe(&TOPIC, capacity)` (bounded; a reader that falls behind gets
`RecvError::Lagged(n)` and re-reads its state). Dropping the subscription ends it.

**Register a job.**

```rust
let job = kernel.jobs.start(JobSpec::new("note-export", None, id, "Exporting note").on_stop(stop));
job.update(|j| j.progress = Some(JobProgress { done, total }));   // ≤ 1 `jobs:change` per 500 ms
job.finish(JobStatus::Completed, |j| j.detail = None);            // a start and an end go at once
```

A module lists what it contributes (`routes`, `topics`, `job_kinds`, `idle_hooks`, …) in its
`Module` impl; `Runtime::build` composes the modules and fails, naming both owners, on any clash.

## Ordering guarantees

The TypeScript daemon got these from Node's single thread. Here they are explicit.

1. **One order.** Every event is delivered on the ordered lane, one at a time. All handlers see
   the same sequence and the stream's ids (`<epoch>-<seq>`) follow it.
2. **A caller's order is kept.** Events published from one thread are delivered in that order —
   so a writer that commits and then publishes announces its changes in commit order.
3. **State before its event.** A publish made after a change is delivered after the change is
   visible. A transition that must not be overtaken by another transition's event runs as one
   lane job: `Ordered::run(|| { change; publish })`. Lane jobs are plain closures: they cannot
   `.await`, so nothing holds the lane across a suspension point.
4. **Synchronous on the lane.** Inside a lane job, `publish` has reached every handler when it
   returns (as in Node). From any other thread it queues; `bus.flush().await` waits for it.
5. **Run to completion.** An event a handler publishes goes out after the event being delivered,
   to everyone. (Node delivered it in the middle, so later subscribers — the stream among them —
   saw the effect before its cause. Not copied.)
6. **Replay, then register.** A stream's replay and its registration for live events happen
   under one lock: no event falls between them, none arrives twice.
7. **Delta coalescing.** A block's first `agent:delta` passes at once; the following ones are
   merged per 50 ms window; any other event first releases what is held, so text never trails
   what follows it.
8. **Isolation.** A panicking handler, lane job, idle hook, module hook or request is logged and
   fails alone.

## Bounds

| Thing | Bound | When full |
|---|---|---|
| ordered lane | 4,096 jobs | callers wait (back-pressure), nothing is dropped |
| stream ring | 5,000 events / 8 MB | oldest dropped; a client behind it gets `resync` |
| one stream's queue | 1,024 frames / 1 MB unread | the stream ends; the client reconnects from its last id and replays |
| open streams | 512 | 503 |
| focus of tabs with no stream | 256 | oldest forgotten |
| `bus.subscribe` queue | caller's capacity | event dropped for that reader, reported as `Lagged` |
| jobs | 1,024 held, 50 finished, 256 KiB output each | oldest finished (then longest-running) dropped |
| live text | 6 blocks per worker, stopped blocks 2 min | oldest dropped |
| request body | 1 MiB (`RouteDef::max_body`) | 413 |

Every subscription and stream is removed when dropped (tests run thousands of cycles and check).

## Seams

- The clock and the id source are `eos-core`'s (`Clock`, `Ids`); agent events, live blocks, the
  `/stream/focus` request and topic names are `eos-contracts`' types. `BackgroundJob` / `JobChange` /
  `JobOutput` are still defined beside the job registry (the contract type names its kinds as a closed
  list; the registry takes any declared kind).
- A port's failure (`eos_core::Error`) and a failed contract check (`eos_contracts::ValidationError`)
  convert to `ApiError` with `?`; `Request::parse::<T>()` reads and checks a body in one call.
- `bus::Announce`: `out.announce(&TOPIC, &payload)` inside a store write job — the event leaves after
  COMMIT, in commit order (see `eos-core`'s `store`).
- `StreamOptions::display_filter`: the sender-tag stripping every stream payload goes through
  (`eos-domain`).
- `SlashCommandDecl::command`, `SyncContribution::handle`: carried unopened for the session and
  sync services.
- For `eos-app`: `Kernel::new` → build modules from it → `Runtime::build` → `lifecycle.start()` →
  hand `runtime.router` to the bridge and gateways → `lifecycle.ready()` → `runtime.shutdown(deadline)`.
  The app classifies local callers (ui-token / a host's view token → `LocalCaller`), passes
  `local_only_under(…)` for today's local-only areas, supplies the `PluginSwitch`, runs
  `runtime.idle` when a worker settles, and repeats the `router.undeclared()` test over the real table.
- Guarantee 2 orders a database write with its event because the store publishes on the writer
  thread after COMMIT (`Db::write_then_async`, wired in `eos-app`). A caller that publishes after
  `store.write(…)` returned is on its own thread, where commit order is not publish order: use the
  job's outbox instead.
- For gateways: `Response::refusal` says why a caller was turned away (the phone gateway maps it
  to its own error frame); gzip for a peer link is the gateway's, not the router's.

## Check

```bash
cargo test -p eos-runtime     # unit tests + tests/ (a feature end to end, today's access tables)
cargo bench -p eos-runtime    # fan-out, route matching, full-ring replay
```
