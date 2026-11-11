//! The smaller tables: what the TypeScript repositories did, on the seeded rows.

use eos_contracts::{GoalSpec, LoopStatus, LoopStrategy, WorkerDefinition};
use eos_core::store::{NewLoop, NewPending, NewQueuedMessage, WorktreeRemoval};
use eos_domain::message_queue::{MessagePlane, QueueMeta};
use eos_testkit::{TempStore, fixtures};
use serde_json::json;

fn seeded() -> TempStore {
    TempStore::seeded("{sandbox}")
}

#[test]
fn open_permission_asks_are_listed_as_recorded_then_resolved_or_swept() {
    let temp = seeded();
    let open = temp.store.read_blocking(|tx| tx.pending().list_unresolved()).expect("reads");
    let rows: Vec<_> = open.iter().map(|p| serde_json::to_value(p.to_list_row()).expect("serializes")).collect();
    // GET /pending answered exactly these keys (fixtures/wire/recordings/11-chats.json).
    assert_eq!(json!(rows), fixtures::recorded_response("11-chats", "pending")["json"]);
    assert!(
        serde_json::to_value(open[0].to_row()).expect("serializes").get("tool_use_id").is_some(),
        "one row carries it"
    );

    let outcome = temp
        .store
        .write_blocking(|tx, _| {
            let pending = tx.pending();
            pending.insert(&NewPending {
                id: "p-stale".into(),
                worker_id: "w-CHAT".into(),
                tool_name: "Bash".into(),
                input: r#"{"command":"ls"}"#.into(),
                tool_use_id: Some("call_1".into()),
                created_at: 10,
                expires_at: 20,
            })?;
            let swept = pending.sweep_expired(1000, "daemon restart sweep")?;
            let resolved = pending.resolve("p-SEED1", "allow", None, Some(r#"{"command":"node --test --watch"}"#))?;
            let again = pending.resolve("p-SEED1", "deny", Some("too late"), None)?;
            Ok((
                swept,
                resolved,
                again,
                pending.find("p-stale")?,
                pending.find("p-SEED1")?,
                pending.list_unresolved()?.len(),
            ))
        })
        .expect("writes");
    let (swept, resolved, again, stale, seed, still_open) = outcome;
    assert_eq!(
        (swept, resolved, again, still_open),
        (1, true, false, 0),
        "only the expired ask is swept; a decision is final"
    );
    let stale = stale.expect("the row");
    assert_eq!(
        (stale.resolved, stale.decision.as_deref(), stale.reason.as_deref()),
        (true, Some("deny"), Some("daemon restart sweep"))
    );
    let seed = seed.expect("the row");
    assert_eq!(
        (seed.decision.as_deref(), seed.updated_input.as_deref()),
        (Some("allow"), Some(r#"{"command":"node --test --watch"}"#))
    );
}

fn message(text: &str, client: Option<&str>, plane: MessagePlane, dispatched_at: Option<i64>) -> NewQueuedMessage {
    NewQueuedMessage {
        worker_id: "w-CHAT".into(),
        client_msg_id: client.map(str::to_owned),
        text: text.into(),
        created_at: 100,
        dispatched_at,
        meta: QueueMeta::default(),
        plane,
    }
}

#[test]
fn queued_messages_wait_in_order_and_a_repeated_send_is_ignored() {
    let temp = TempStore::new();
    let outcome = temp
        .store
        .write_blocking(|tx, _| {
            let queue = tx.message_queue();
            let first = queue.insert(&message("one", Some("c-1"), MessagePlane::User, None))?;
            let repeat = queue.insert(&message("one again", Some("c-1"), MessagePlane::User, None))?;
            let with_meta = NewQueuedMessage {
                meta: QueueMeta {
                    display_text: Some("shown".into()),
                    envelope: Some(json!({ "kind": "worker_report" })),
                    ..QueueMeta::default()
                },
                ..message("report", None, MessagePlane::Agent, None)
            };
            let report = queue.insert(&with_meta)?;
            queue.insert(&message("delivered", Some("c-2"), MessagePlane::User, Some(500)))?;
            queue.insert(&message("old", Some("c-0"), MessagePlane::User, Some(5)))?;
            queue.prune(100)?;
            Ok((
                first,
                repeat,
                report,
                queue.list_pending("w-CHAT")?,
                queue.list_pending_user_plane("w-CHAT")?,
                queue.has_recent_dispatch("w-CHAT", "delivered", 400)?,
                queue.has_recent_dispatch("w-CHAT", "old", 0)?,
            ))
        })
        .expect("writes");
    let (first, repeat, report, pending, user, recent, pruned_still_there) = outcome;
    assert!(first.is_some() && report.is_some());
    assert_eq!(repeat, None, "the same client id twice is one message");
    assert_eq!(pending.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["one", "report"]);
    assert_eq!(
        user.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(),
        ["one"],
        "an agent's message is not the user's"
    );
    assert_eq!(pending[1].meta.display_text.as_deref(), Some("shown"));
    assert_eq!(pending[1].meta.envelope, Some(json!({ "kind": "worker_report" })));
    assert!(recent && !pruned_still_there);

    let (removed, missing, cleared) = temp
        .store
        .write_blocking(move |tx, _| {
            let queue = tx.message_queue();
            let id = first.unwrap_or_default();
            queue.mark_dispatched(&[id], 900)?;
            Ok((
                queue.remove_pending("w-CHAT", id)?,
                queue.remove_pending("w-CHAT", 9999)?,
                queue.clear_pending("w-CHAT")?,
            ))
        })
        .expect("writes");
    assert_eq!((removed, missing, cleared), (false, false, 1), "a delivered message is no longer pending");
}

#[test]
fn loops_are_read_whatever_shape_their_goal_has() {
    let temp = seeded();
    let goal: GoalSpec = serde_json::from_value(
        json!({ "summary": "docs build", "criteria": [{ "id": "c1", "text": "make docs passes" }] }),
    )
    .expect("a goal");
    let outcome = temp
        .store
        .write_blocking(move |tx, _| {
            let loops = tx.loops();
            // The seed's finished loop predates criteria: it is still readable.
            let seeded = loops.find_any_by_worker("w-KID1")?;
            assert_eq!(loops.list_active()?.len(), 0);
            loops.insert(&NewLoop {
                id: "l-1".into(),
                worker_id: "w-KID2".into(),
                parent_id: Some("o-ORCH".into()),
                goal,
                strategy: LoopStrategy::Hybrid,
                max_attempts: None,
                started_at: 50,
            })?;
            loops.set_awaiting_input("l-1", true, 60)?;
            loops.set_held_report("l-1", Some("done"), 61)?;
            loops.set_check_failures("l-1", 2, 62)?;
            let active = loops.find_active_by_worker("w-KID2")?;
            loops.set_status("l-1", LoopStatus::Stopped, 77)?;
            Ok((seeded, active, loops.list_active()?.len(), loops.find("l-1")?))
        })
        .expect("writes");
    let (seeded, active, still_active, stopped) = outcome;
    let seeded = seeded.expect("the seeded loop");
    assert_eq!(
        (seeded.status, seeded.goal_summary(), seeded.goal_spec()),
        (LoopStatus::Passed, Some("tests pass"), None)
    );
    assert_eq!((seeded.attempt, seeded.max_attempts, seeded.last_reason.as_deref()), (2, Some(5), Some("exit 0")));

    let active = active.expect("the new loop");
    assert!(active.awaiting_input);
    assert_eq!((active.held_report.as_deref(), active.check_failures, active.updated_at), (Some("done"), 2, 62));
    assert_eq!(active.goal_spec().map(|g| g.criteria.len()), Some(1));
    let row = serde_json::to_value(active.to_row()).expect("serializes");
    assert_eq!(
        row,
        json!({ "status": "active", "attempt": 0, "maxAttempts": null, "lastReason": null, "goalSummary": "docs build" })
    );
    assert_eq!(still_active, 0);
    assert_eq!(stopped.map(|l| (l.status, l.updated_at)), Some((LoopStatus::Stopped, 77)));
}

#[test]
fn per_worker_counters_and_marks() {
    let temp = seeded();
    let (ids, marks) = temp
        .store
        .write_blocking(|tx, _| {
            let ids = (
                tx.message_ids().next_assistant("w-new")?,
                tx.message_ids().next_inbound("w-new")?,
                tx.message_ids().next_assistant("w-new")?,
                tx.message_ids().next_assistant("w-new")?,
                tx.message_ids().next_inbound("w-new")?,
            );
            let marks = (
                tx.context_marks().has("w-LONG", "warn")?,
                tx.context_marks().mark("w-LONG", "warn", 5)?,
                tx.context_marks().mark("w-LONG", "full", 5)?,
                tx.context_marks().has("w-LONG", "full")?,
            );
            tx.context_marks().clear("w-LONG")?;
            assert!(!tx.context_marks().has("w-LONG", "warn")?);
            Ok((ids, marks))
        })
        .expect("writes");
    assert_eq!(ids, ("0.1".to_owned(), 1, "1.1".to_owned(), "1.2".to_owned(), 2));
    assert_eq!(marks, (true, false, true, true));
}

#[test]
fn worktree_removals_and_runtime_definitions() {
    let temp = TempStore::new();
    let definition: WorkerDefinition =
        serde_json::from_value(json!({ "name": "scout", "description": "Looks around" })).expect("a definition");
    let (queued, listed, other) = temp
        .store
        .write_blocking(move |tx, _| {
            let removals = tx.worktree_removals();
            let entry = |id: &str, at: i64| WorktreeRemoval {
                id: id.into(),
                worker_id: "w-1".into(),
                repo_root: "/repo".into(),
                worktree_dir: Some("/repo/.trees/x".into()),
                branch: "eos/x".into(),
                scheduled_at: at,
            };
            removals.enqueue(&entry("b", 20))?;
            removals.enqueue(&entry("a", 30))?;
            removals.enqueue(&entry("b", 40))?;
            let queued: Vec<String> = removals.list()?.into_iter().map(|e| e.id).collect();
            removals.delete("a")?;

            let definitions = tx.worker_definitions();
            definitions.create("o-1", &definition, 5)?;
            definitions.create("o-1", &definition, 6)?;
            Ok((queued, definitions.list_for("o-1")?, definitions.list_for("o-2")?.len()))
        })
        .expect("writes");
    assert_eq!(queued, ["a", "b"], "an entry scheduled again moves back");
    assert_eq!(listed.len(), 1, "a definition is replaced by name");
    assert_eq!(serde_json::to_value(&listed[0]).expect("serializes")["source"], "runtime");
    assert_eq!(other, 0);
}
