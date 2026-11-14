# Adding a feature

The steps a feature follows, in order. `ARCHITECTURE.md` says why; this says how.
Worked example throughout: a feature called `notes`.

## 1. The crate

```
crates/eos-mod-notes/
  Cargo.toml      [lints] workspace = true; version/edition/… = workspace
  src/lib.rs      pub struct NotesModule + impl Module, one module per route group
```

- Layer **feature**. Add `("eos-mod-notes", Layer::Feature)` to `xtask/src/layers.rs` and
  `eos-mod-notes = { path = "crates/eos-mod-notes" }` to the workspace `Cargo.toml` — each on its own
  line, in alphabetical order.
- May depend on `eos-contracts`, `eos-domain`, `eos-core`, a service crate, `eos-runtime`.
  Never on an adapter (`eos-store-sqlite`, `eos-config`, …) and never on another `eos-mod-*`:
  what it needs from outside arrives through its constructor as `Arc<dyn Port>`.
- Dev-dependencies: `eos-testkit`, `tokio` (`macros`, `rt-multi-thread`).

## 2. Where things go

| Thing | Where |
|---|---|
| request / response / event payload shapes | `eos-contracts` (they exist already: use them, never a local copy) |
| a pure rule or entity several features use | `eos-domain` |
| a rule only this feature uses | the feature crate |
| a trait over something outside the process | `eos-core/src/<area>.rs` (`agent`, `git`, `net`, `os`, `policy`, `prompt`, `store`) |
| its real implementation | the adapter crate of that outside system |
| its fake | `eos-testkit`, named `Fake<Port>` |

Time and ids come from `Arc<dyn Clock>` and `Arc<dyn Ids>` (`eos-core`): never `SystemTime::now()`
or a random call in a feature. `Ids` already has every shape the app mints (`w-…`, `pg-…`,
`v_…`, uuids); a new kind of id is a new provided method there.

## 3. The module

```rust
pub struct NotesModule {
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
}

impl NotesModule {
    pub fn new(store: Arc<dyn Store>, clock: Arc<dyn Clock>) -> Self { … }
}

pub const NOTES_CHANGE: Topic<NoteChange> = Topic::new("notes:change");

impl Module for NotesModule {
    fn id(&self) -> &'static str { "notes" }
    fn routes(&self) -> Vec<RouteDef> { routes::all(self.store.clone(), self.clock.clone()) }
    fn topics(&self) -> Vec<TopicDecl> { vec![NOTES_CHANGE.decl()] }
    fn job_kinds(&self) -> Vec<&'static str> { vec!["note-export"] }
}
```

Then **one line** in `crates/eos-app/src/modules.rs`, in alphabetical order:

```rust
Arc::new(eos_mod_notes::NotesModule::new(cx.store.clone(), cx.clock.clone())),
```

and `eos-mod-notes.workspace = true` in `eos-app/Cargo.toml`. A dependency the context does not
hold yet (a new adapter, a new port) is one field of `Context` and one line where `App::build`
fills it. Nothing else in the app changes.
`Runtime::build` fails, naming both owners, when two modules claim one route, topic, job kind,
idle hook, slash command, settings key or sync domain.

## 4. A route

```rust
RouteDef::get("/api/notes/{id}", move |req: Request| {
    let store = store.clone();
    async move {
        let id = req.param("id").unwrap_or_default().to_owned();
        let note = store.read(move |tx| tx.notes().find(&id)).await?;      // eos_core::Error → status
        let note = note.ok_or_else(|| ApiError::NotFound("not found".into()))?;
        Ok(Response::json(200, &note.to_wire()))
    }
})
.access(Access::open().phone(Tier::Read))
```

- The access rule is not optional: `ui_token()` for what only the user's own dashboard may do,
  `.local_only()` for what never crosses to a paired computer, and the phone's tier (none, read
  or act). A route of the recorded wire keeps the rule it had. A route without one fails the
  build.
- A body: `let body: CreateNoteRequest = req.parse()?;` — reads the contract type (a JSON object;
  `parse_value` for the rare list or `null` body) and applies its rules, answering
  `400 invalid request: <path>: <message>` in Zod's words. Query values:
  `req.query().get("limit")`, validated through the contract's query type with `eos_contracts::parse`.
- Errors: a use-case returns `eos_core::Error` and the handler uses `?`; the mapping to a status
  and `{ "error": … }` is in `eos-runtime` only. A body the recorded route words itself
  (`{"error":"not found"}` without an id) is an explicit `ApiError`.
- Write response fields in the recorded order, omit exactly what the recorded wire omits, and keep stored
  JSON as the string it is (`payload`, `input`).
- A route that is not finished stays unregistered. Never answer a fake success.

## 5. Data

**`state.db`** is reached only through `Arc<dyn Store>`:

```rust
let note = store.read(move |tx| tx.notes().find(&id)).await?;          // one snapshot, read-only

store.write(move |tx, out| {                                            // one job on the writer thread
    let mut note = tx.notes().find(&id)?.ok_or_else(|| Error::not_found("note", &id))?;
    note.rename(&title)?;                                               // the domain rule
    tx.notes().save(&note)?;
    out.announce(&NOTES_CHANGE, &NoteChange { id });                    // leaves after COMMIT
    Ok(note)
}).await?;
```

- A read-modify-write is **one** `write` job: nothing else touches the database between its steps.
  Returning `Err` undoes the job's changes and drops its announcements.
- A job is synchronous. It must not block on anything but the database, must not call the store
  again, and never runs on the ordered lane.
- Every table has its repository already (`tx.workers()`, `events()`,
  `pending()`, `message_queue()`, `message_ids()`, `context_marks()`, `worktree_removals()`,
  `worker_definitions()`, `dreams()`, `transfers()`, `genui_views()`); `worker_loops` has none,
  since the app has no goal loops. A method that is missing is added to its trait in
  `eos-core/src/store/` and its SQL in `eos-store-sqlite/src/`.
- A new table: `eos-kit-sqlite/migrations/NNN_name.sql` + its line in `migrate/embedded.rs` (new
  tables only, never a column on an existing table); the repository trait in
  `eos-core/src/store/<table>.rs` with an accessor on `Tx`; its SQL in
  `eos-store-sqlite/src/<table>.rs`, returning `eos-domain` entities; a test in
  `eos-store-sqlite/tests/` that compares rows with the recorded wire.
- Configuration: `Arc<dyn ConfigSource>`; call `current()` per piece of work (a reload swaps the
  snapshot). It changes only through `patch(section, …)`, which writes `config.json` and reloads.

**A file store** (`pages/`, `profile/`, `projects.json`, …) is a port in `eos-core::store` with
its implementation over `eos-kit-fs` (`atomic_write`, `PathLocks`, `frontmatter`) in
`eos-store-files` (`projects.rs` is the model); the feature holds `Arc<dyn …Store>`. The on-disk
format does not change.

## 6. Events

| What changed | How it is announced |
|---|---|
| a row in `state.db` | `out.announce(&TOPIC, &payload)` inside the write job. Events leave on the writer thread after COMMIT, so they arrive in commit order. Never `bus.publish` after `store.write(…)` returned: that is the caller's thread, and two callers' events can swap. |
| state in memory | `kernel.ordered.run(move \|\| { change; bus.publish(&TOPIC, &payload); }).await?` — change and event are one lane job. |
| a file under the data folder | publish after the write returned, from the code that holds that file's lock (`PathLocks`). |

A scoped topic (`Topic::scoped`: live text, terminal output) is always published on the bus
directly. Subscribing: `bus.on(&TOPIC, …)` runs on the lane and must not block;
`bus.subscribe(&TOPIC, capacity)` reads at the feature's own pace.

## 7. Jobs, idle hooks, the rest

`kernel.jobs.start(JobSpec::new("note-export", worker_id, reference, title))` for anything the
Jobs tab should show; `Module::idle_hooks` for work at a worker's IDLE edge (give it an order
among the others); `plugin()`, `protected_settings()`, `sync()`, `holds_worker()`,
`follows_tool_input()`, `on_agent_event()`, `start()` / `after_ready()` / `stop()` as the
`Module` trait documents them (`crates/eos-runtime/README.md`).

## 8. Tests

- **Rules**: unit tests beside the code.
- **Routes**: in the feature crate's `tests/`, against the real store:

  ```rust
  let temp = TempStore::seeded("/sandbox");                      // the wire fixtures' invented rows
  let module = Arc::new(NotesModule::new(temp.port(), Arc::new(FakeClock::new())));
  let runtime = Runtime::build(Kernel::new(KernelOptions::default()), vec![module], Arc::new(AllPluginsOn))?;
  let res = runtime.router.handle(Request::new(Method::Get, "/api/notes/n-1", Caller::DASHBOARD)).await;
  ```

  `temp.announced.list()` is what the writes announced, in commit order; `temp.exec(sql)` sets up
  a state by hand. `FakeClock`, `SeqIds` and `TempHome` make every run identical
  (`crates/eos-mod-workers/tests/routes.rs` is the model).
- **The app**: a test that needs start-up or several features goes in `crates/eos-app/tests/`
  (`read_path.rs` builds the app on `TempHome::seeded` and compares answers with recordings).
- **The wire**: anything that must equal the recorded answer is compared with a recording
  (`eos_testkit::fixtures::recorded_response("31-pages", "create")`), never with a hand-written
  guess.
- **Replay** is the judge of a route group: the recordings (`fixtures/wire/recordings`) run
  against the composed app, in process:

  ```bash
  scripts/replay.sh --only 31-pages,32-profile --verbose   # the synthetic seed, fresh every run
  scripts/replay.sh --private <copy of a real data folder>  # values never printed
  ```

  Steps whose route is not registered yet are counted apart (`not served yet`); the run fails
  only when an answered step differs in a way nobody listed. A group is done when its recordings
  pass with `--only`, or every remaining difference is in `fixtures/wire/rust-differences.toml`
  with its reason. The recordings are frozen (nothing records any more, `fixtures/README.md`): a route
  the 0.1.x app never had is pinned by the crate's own tests.
- No `unwrap` in library code; no sleeps in tests (wait for the event); `scripts/check.sh` green
  before every merge.
