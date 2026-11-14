//! Workers and events against what the TypeScript repositories answered: the
//! recorded wire of the seeded data folder (`rust/fixtures/wire`).

use eos_contracts::{NameSource, WorkerEventType, WorkerState};
use eos_core::Error;
use eos_core::store::{EventOrder, EventQuery, NewWorker};
use eos_domain::Usage;
use eos_testkit::{TempStore, fixtures};
use serde_json::Value;

/// The recordings write the seeded projects' folder as this placeholder.
const SANDBOX: &str = "{sandbox}";

fn seeded() -> TempStore {
    TempStore::seeded(SANDBOX)
}

fn recorded_rows(scenario: &str, step: &str) -> Vec<Value> {
    fixtures::recorded_response(scenario, step)["json"].as_array().expect("a list").clone()
}

/// What a route adds to a row; the repository never returns it.
const ADDED_BY_ROUTE: [&str; 1] = ["context"];

/// Compares a row with its recording, key by key. Values the recording
/// normalized (`<uuid:N>`) and the keys in `skip` are not compared.
fn assert_row(actual: &Value, recorded: &Value, skip: &[&str]) {
    let (actual, recorded) = (actual.as_object().expect("object"), recorded.as_object().expect("object"));
    let id = &recorded["id"];
    for (key, want) in recorded {
        let key = key.as_str();
        if ADDED_BY_ROUTE.contains(&key) {
            assert!(!actual.contains_key(key), "{id}.{key} is the route's to add");
        } else if !skip.contains(&key) && !want.as_str().is_some_and(|s| s.starts_with('<')) {
            assert_eq!(actual.get(key), Some(want), "{id}.{key}");
        }
    }
    for key in actual.keys() {
        assert!(recorded.contains_key(key), "{id}.{key} is not on today's wire");
    }
}

#[test]
fn worker_rows_are_the_recorded_ones() {
    let temp = seeded();
    let active = temp.store.read_blocking(|tx| tx.workers().list_active()).expect("reads");
    let recorded = recorded_rows("11-chats", "list");
    assert_eq!(
        active.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(),
        recorded.iter().map(|r| r["id"].as_str().expect("id")).collect::<Vec<_>>(),
        "newest first, archived left out"
    );
    for (worker, recorded) in active.iter().zip(&recorded) {
        let row = serde_json::to_value(worker.to_row()).expect("serializes");
        // The recording was made after start-up had parked the chat that was
        // WORKING when the seed "crashed"; this database has not been started.
        let skip: &[&str] = if worker.id == "w-BUSY" { &["state"] } else { &[] };
        assert_row(&row, recorded, skip);
    }

    let archived = temp.store.read_blocking(|tx| tx.workers().list_archived()).expect("reads");
    let recorded = recorded_rows("11-chats", "archived");
    assert_eq!(archived.len(), recorded.len());
    for (worker, recorded) in archived.iter().zip(&recorded) {
        assert_row(&serde_json::to_value(worker.to_row()).expect("serializes"), recorded, &[]);
    }

    let orchestrators = temp.store.read_blocking(|tx| tx.workers().list_orchestrators()).expect("reads");
    assert_eq!(orchestrators.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(), ["o-ORCH"]);
    let children = temp.store.read_blocking(|tx| tx.workers().list_by_parent("o-ORCH")).expect("reads");
    let recorded = recorded_rows("11-chats", "list-children");
    assert_eq!(
        children.iter().map(|w| w.id.as_str()).collect::<Vec<_>>(),
        recorded.iter().map(|r| r["id"].as_str().expect("id")).collect::<Vec<_>>()
    );
}

fn page(temp: &TempStore, query: EventQuery) -> Vec<Value> {
    let rows = temp.store.read_blocking(move |tx| tx.events().list(&query)).expect("reads");
    rows.into_iter().map(|r| serde_json::to_value(r.into_row()).expect("serializes")).collect()
}

fn query(worker: &str) -> EventQuery {
    EventQuery {
        worker_id: worker.into(),
        since: 0,
        limit: 500,
        order: EventOrder::Desc,
        before_id: None,
        after_id: None,
    }
}

#[test]
fn transcript_pages_are_the_recorded_ones() {
    let temp = seeded();
    let newest = page(&temp, query("w-LONG"));
    assert_eq!(newest, recorded_rows("12-transcript", "default-page"), "the newest 500, oldest first");

    let oldest_seen = newest.last().and_then(|r| r["id"].as_i64()).expect("an id");
    let before = page(&temp, EventQuery { before_id: Some(oldest_seen), limit: 200, ..query("w-LONG") });
    assert_eq!(before, recorded_rows("12-transcript", "page-before"));

    let all = page(&temp, EventQuery { limit: 5000, order: EventOrder::Asc, ..query("w-LONG") });
    assert_eq!(all, recorded_rows("12-transcript", "page-max"));

    let since = page(&temp, EventQuery { since: 1_790_000_715_000, order: EventOrder::Asc, ..query("w-LONG") });
    assert_eq!(since, recorded_rows("12-transcript", "since-time"));

    let first = newest.first().and_then(|r| r["id"].as_i64()).expect("an id");
    let after = page(&temp, EventQuery { after_id: Some(first), ..query("w-LONG") });
    assert_eq!(after, recorded_rows("12-transcript", "after-newest"));

    // Every row kind of the seeded full transcript. Its recording masks ids
    // and durations inside the payloads, so those are compared by the replay.
    let chat = page(&temp, EventQuery { order: EventOrder::Asc, ..query("w-CHAT") });
    let recorded = recorded_rows("12-transcript", "full-transcript");
    let shape =
        |rows: &[Value]| rows.iter().map(|r| (r["id"].clone(), r["ts"].clone(), r["type"].clone())).collect::<Vec<_>>();
    assert_eq!(shape(&chat), shape(&recorded));
    let unmasked =
        recorded.iter().zip(&chat).filter(|(want, _)| !want["payload"].as_str().is_some_and(|p| p.contains('<')));
    for (want, got) in unmasked {
        assert_eq!(got["payload"], want["payload"], "row {}", want["id"]);
    }

    assert!(page(&temp, query("w-nope0000")).is_empty(), "an unknown worker has an empty log");
}

#[test]
fn rows_of_one_kind_and_single_rows() {
    let temp = seeded();
    let (prompts, capped, found, foreign) = temp
        .store
        .read_blocking(|tx| {
            let events = tx.events();
            let prompts = events.list_by_type("w-LONG", WorkerEventType::UserMessage, None)?;
            let capped = events.list_by_type("w-LONG", WorkerEventType::UserMessage, Some(3))?;
            let id = prompts[0].id;
            Ok((prompts, capped, events.find("w-LONG", id)?, events.find("w-CHAT", id)?))
        })
        .expect("reads");
    assert_eq!(prompts.len(), 155);
    assert!(prompts.windows(2).all(|w| w[0].id < w[1].id), "insertion order");
    assert_eq!(capped.len(), 3);
    assert_eq!(found.as_ref(), Some(&prompts[0]));
    assert_eq!(foreign, None, "a row is never read through another worker's id");
}

fn new_worker(id: &str) -> NewWorker {
    NewWorker {
        id: id.into(),
        prompt: "Do the thing.".into(),
        cwd: Some("/work".into()),
        worktree_from: None,
        branch: None,
        name: Some("Thing".into()),
        name_source: NameSource::Default,
        pid: Some(4242),
        port: 7600,
        started_at: 1_800_000_000_000,
        parent_id: None,
        model: "opus".into(),
        effort: Some("high".into()),
        is_orchestrator: false,
        backend_kind: "claude".into(),
        backend_profile: None,
        agent_role: Some("focused".into()),
        worker_definition: None,
        tool_scope: None,
        with_gateway: false,
        collaborate: true,
        worktree_dir: None,
        workspace_owner_id: None,
        workspace_ready: true,
        scratch: false,
    }
}

#[test]
fn a_worker_goes_through_its_writes() {
    let temp = TempStore::new();
    let worker = temp
        .store
        .write_blocking(|tx, _| {
            let workers = tx.workers();
            workers.insert(&new_worker("w-1"))?;
            workers.update_state("w-1", WorkerState::Working)?;
            workers.add_usage("w-1", &Usage { tokens_in: 10, tokens_out: 4, cost_usd: 0.5, ..Usage::default() })?;
            workers.add_usage(
                "w-1",
                &Usage { tokens_in: 5, tokens_cache_read: 100, cost_usd: 0.25, ..Usage::default() },
            )?;
            workers.set_context_tokens("w-1", 900)?;
            workers.increment_tool_calls("w-1")?;
            workers.set_engine_session("w-1", "w-1")?;
            workers.set_tasks("w-1", Some("[]"))?;
            assert!(workers.update_name_if_source("w-1", "Auto name", NameSource::Default, NameSource::Auto)?);
            assert!(!workers.update_name_if_source("w-1", "Again", NameSource::Default, NameSource::Auto)?);
            workers.update_name("w-1", Some("Mine"), NameSource::User)?;
            assert!(!workers.update_name_if_source("w-1", "Auto", NameSource::Auto, NameSource::Auto)?);
            workers.find("w-1")
        })
        .expect("writes")
        .expect("the row");
    assert_eq!(worker.state, WorkerState::Working);
    assert_eq!(worker.turn_started_at, Some(1_800_000_000_000), "the first turn starts with the worker");
    assert_eq!(
        worker.usage,
        Usage { tokens_in: 15, tokens_out: 4, tokens_cache_read: 100, cost_usd: 0.75, ..Usage::default() }
    );
    assert_eq!((worker.last_context_tokens, worker.tool_calls), (Some(900), 1));
    assert_eq!((worker.name.as_deref(), worker.name_source), (Some("Mine"), Some(NameSource::User)));
    assert!(worker.collaborate && worker.workspace_ready && !worker.scratch);

    let ended = temp
        .store
        .write_blocking(|tx, _| {
            let workers = tx.workers();
            workers.mark_done("w-1", 1_800_000_009_000, Some(0))?;
            workers.clear_runtime("w-1")?;
            workers.set_archived("w-1", Some(1_800_000_010_000))?;
            Ok((
                workers.find("w-1")?,
                workers.list_active()?.len(),
                workers.list_archived()?.len(),
                workers.count_by_state()?,
            ))
        })
        .expect("writes");
    let (row, active, archived, counts) = ended;
    let row = row.expect("the row");
    assert_eq!(
        (row.state, row.ended_at, row.exit_code, row.pid, row.port),
        (WorkerState::Done, Some(1_800_000_009_000), Some(0), None, None)
    );
    assert_eq!((active, archived), (0, 1));
    assert_eq!(counts, [("DONE".to_owned(), 1)]);

    let revived = temp
        .store
        .write_blocking(|tx, _| {
            tx.workers().reactivate("w-1", None, 7601)?;
            tx.workers().find("w-1")
        })
        .expect("writes")
        .expect("the row");
    assert_eq!((revived.ended_at, revived.exit_code, revived.port), (None, None, Some(7601)));

    temp.store.write_blocking(|tx, _| tx.workers().delete("w-1")).expect("deletes");
    assert_eq!(temp.store.read_blocking(|tx| tx.workers().find("w-1")).expect("reads"), None);
    assert_eq!(temp.count("SELECT COUNT(*) FROM engine_sessions"), 0, "its session goes with it");
}

// The TypeScript app resumes a chat by `workers.session_id`: `ResumeWorker.ts`
// refuses a row without one ("worker has no recorded session to resume") and
// passes it as `options.resume` to Claude Code (`ClaudeSdkBackend.ts`), which
// takes only a UUID with a transcript under its projects folder. So that a
// user can go back to that app, this app never writes the column.
#[test]
fn the_session_the_typescript_app_resumes_by_is_never_replaced() {
    let temp = TempStore::new();
    let claude = "0b8f3c1e-7d2a-4c55-9a51-3e9d2f6a8b10";
    temp.store
        .write_blocking(|tx, _| {
            tx.workers().insert(&new_worker("w-old"))?;
            tx.workers().insert(&new_worker("w-new"))
        })
        .expect("writes");
    temp.exec(&format!("UPDATE workers SET session_id = '{claude}' WHERE id = 'w-old'"));

    // Both sessions come up in this app under the worker's own id.
    let (old, new) = temp
        .store
        .write_blocking(|tx, _| {
            tx.workers().set_engine_session("w-old", "w-old")?;
            tx.workers().set_engine_session("w-new", "w-new")?;
            Ok((tx.workers().find("w-old")?, tx.workers().find("w-new")?))
        })
        .expect("writes");
    let column =
        |id: &str| temp.count(&format!("SELECT COUNT(*) FROM workers WHERE id = '{id}' AND session_id IS NULL"));
    assert_eq!(
        temp.count(&format!("SELECT COUNT(*) FROM workers WHERE id = 'w-old' AND session_id = '{claude}'")),
        1,
        "the chat goes on in the TypeScript app from its Claude Code session"
    );
    assert_eq!(column("w-new"), 1, "a chat begun here has none the TypeScript app could resume");
    assert_eq!(old.expect("the row").session_id.as_deref(), Some(claude), "a resume here reads it too");
    assert_eq!(new.expect("the row").session_id.as_deref(), Some("w-new"), "and this app's own when it has no other");
}

#[test]
fn a_write_announces_after_it_is_saved_and_a_failed_one_leaves_nothing() {
    let temp = TempStore::new();
    let row_id = temp
        .store
        .write_blocking(|tx, out| {
            tx.workers().insert(&new_worker("w-1"))?;
            let row_id =
                tx.events().append_json("w-1", 5, WorkerEventType::State, &serde_json::json!({ "state": "IDLE" }))?;
            out.push("worker:change", &serde_json::json!({ "workerId": "w-1", "rowId": row_id }));
            Ok(row_id)
        })
        .expect("writes");
    assert_eq!(temp.announced.list(), [("worker:change", format!(r#"{{"workerId":"w-1","rowId":{row_id}}}"#))]);

    let failed: Result<(), Error> = temp.store.write_blocking(|tx, out| {
        tx.workers().insert(&new_worker("w-2"))?;
        out.push_bare("worker:spawn");
        Err(Error::Conflict("changed my mind".into()))
    });
    assert_eq!(failed, Err(Error::Conflict("changed my mind".into())));
    assert_eq!(temp.store.read_blocking(|tx| tx.workers().find("w-2")).expect("reads"), None, "undone");
    assert_eq!(temp.announced.topics(), ["worker:change"], "and never announced");

    let stored = temp.store.read_blocking(move |tx| tx.events().find("w-1", row_id)).expect("reads").expect("the row");
    assert_eq!((stored.kind.as_str(), stored.payload.as_deref()), ("state", Some(r#"{"state":"IDLE"}"#)));
}

#[test]
fn a_reader_cannot_write() {
    let temp = seeded();
    let refused = temp.store.read_blocking(|tx| tx.workers().delete("w-CHAT"));
    assert!(matches!(refused, Err(Error::Storage(_))), "{refused:?}");
    assert!(temp.store.read_blocking(|tx| tx.workers().find("w-CHAT")).expect("reads").is_some());
}

#[test]
fn old_events_are_pruned_per_worker() {
    let temp = seeded();
    let removed = temp.store.write_blocking(|tx, _| tx.events().prune_all(100)).expect("prunes");
    assert_eq!(removed, 520, "only the 620-row chat is over the bound");
    let kept = page(&temp, EventQuery { limit: 5000, ..query("w-LONG") });
    assert_eq!(kept.len(), 100);
    assert_eq!(kept.last().expect("a row")["id"], 662, "the newest rows stay");
    assert_eq!(temp.store.write_blocking(|tx, _| tx.events().prune_all(0)).expect("prunes"), 0, "0 keeps everything");

    temp.store.write_blocking(|tx, _| tx.events().delete_by_worker("w-LONG")).expect("deletes");
    assert!(page(&temp, query("w-LONG")).is_empty());
}

#[tokio::test]
async fn the_port_runs_jobs_from_async_code() {
    let temp = seeded();
    let store = temp.port();
    let name = store.read(|tx| Ok(tx.workers().find("w-CHAT")?.and_then(|w| w.name))).await.expect("reads");
    assert_eq!(name.as_deref(), Some("Fix the parser"));

    let renamed = store
        .write(|tx, out| {
            tx.workers().update_name("w-CHAT", Some("Renamed"), NameSource::User)?;
            out.push("worker:change", &serde_json::json!({ "workerId": "w-CHAT" }));
            tx.workers().find("w-CHAT")
        })
        .await
        .expect("writes")
        .expect("the row");
    assert_eq!(renamed.name.as_deref(), Some("Renamed"));
    assert_eq!(temp.announced.topics(), ["worker:change"]);

    let missing: Result<(), Error> = store.write(|_, _| Err(Error::not_found("worker", "w-x"))).await;
    assert_eq!(missing, Err(Error::not_found("worker", "w-x")));
}
