//! The conversation-wide lists' facts beside the log: read in on demand, kept
//! by every append after that, caught up after a build that does not keep
//! them wrote, pruned or removed rows.

use eos_contracts::WorkerEventType;
use eos_core::store::{EventOrder, EventQuery};
use eos_testkit::TempStore;
use serde_json::json;

const W: &str = "w-LISTS";

fn append(temp: &TempStore, ts: i64, kind: WorkerEventType, payload: serde_json::Value) -> i64 {
    temp.store
        .write_blocking(move |tx, _| tx.events().append(W, ts, kind, Some(&payload.to_string())))
        .expect("appends")
}

fn launch(temp: &TempStore, ts: i64, call: &str) -> i64 {
    let payload = json!({"type": "message", "role": "assistant", "blocks": [
        {"type": "tool_call", "callId": call, "name": "Agent", "spawnsSubagent": true, "input": {"description": call}}
    ]});
    append(temp, ts, WorkerEventType::AgentEvent, payload)
}

/// An append by a build that does not keep the facts.
fn append_bypassing(temp: &TempStore, ts: i64, call: &str) {
    let payload = json!({"type": "message", "role": "assistant", "blocks": [
        {"type": "tool_call", "callId": call, "name": "Agent", "spawnsSubagent": true}
    ]})
    .to_string()
    .replace('\'', "''");
    temp.exec(&format!(
        "INSERT INTO events (worker_id, ts, type, payload) VALUES ('{W}', {ts}, 'agent_event', '{payload}')"
    ));
}

fn current(temp: &TempStore) -> bool {
    temp.store.read_blocking(|tx| tx.conversation_lists().is_current(W)).expect("reads")
}

fn catch_up(temp: &TempStore, limit: i64) -> Vec<bool> {
    let mut slices = Vec::new();
    loop {
        let done = temp.store.write_blocking(move |tx, _| tx.conversation_lists().catch_up(W, limit)).expect("writes");
        slices.push(done);
        if done {
            return slices;
        }
    }
}

fn version(temp: &TempStore) -> Option<i64> {
    temp.store.read_blocking(|tx| tx.conversation_lists().version(W)).expect("reads")
}

fn fact_ids(temp: &TempStore) -> Vec<i64> {
    let rows = temp.store.read_blocking(|tx| tx.conversation_lists().facts(W)).expect("reads");
    rows.iter().map(|r| r.id).collect()
}

#[test]
fn a_worker_is_read_in_once_then_kept_by_its_appends() {
    let temp = TempStore::new();
    assert!(current(&temp), "an empty log has nothing to read in");
    let first = launch(&temp, 10, "a");
    append(&temp, 20, WorkerEventType::Policy, json!({"decision": "allow"}));
    let third = launch(&temp, 30, "b");
    assert!(!current(&temp), "never read in");
    assert!(fact_ids(&temp).is_empty(), "appends of a worker not read in add nothing");

    assert_eq!(catch_up(&temp, 1), [false, false, true], "a slice at a time");
    assert!(current(&temp));
    assert_eq!(fact_ids(&temp), [first, third], "rows no list reads have no facts");

    let read_in = version(&temp).expect("a version once read in");
    let fourth = launch(&temp, 40, "c");
    let after_launch = version(&temp).expect("version");
    assert!(after_launch > read_in, "facts changed");
    append(&temp, 50, WorkerEventType::Policy, json!({}));
    assert_eq!(version(&temp), Some(after_launch), "a row no list reads changes nothing");
    assert!(current(&temp), "the append path keeps it");
    assert_eq!(fact_ids(&temp), [first, third, fourth]);
}

#[test]
fn rows_another_build_wrote_are_read_in_on_demand() {
    let temp = TempStore::new();
    let first = launch(&temp, 10, "a");
    catch_up(&temp, 100);
    append_bypassing(&temp, 20, "b");
    let third = launch(&temp, 30, "c");
    assert!(!current(&temp), "the gap leaves the append path alone");
    assert_eq!(fact_ids(&temp), [first]);
    catch_up(&temp, 100);
    assert!(current(&temp));
    assert_eq!(fact_ids(&temp), [first, first + 1, third]);
}

#[test]
fn pruned_and_removed_rows_lose_their_facts() {
    let temp = TempStore::new();
    let ids: Vec<i64> = (1..=4).map(|n| launch(&temp, n * 10, &format!("c{n}"))).collect();
    catch_up(&temp, 100);
    let before = version(&temp);
    temp.store.write_blocking(|tx, _| tx.events().prune_all(2)).expect("prunes");
    assert!(version(&temp) > before, "pruning changed the facts");
    assert!(current(&temp));
    assert_eq!(fact_ids(&temp), ids[2..]);

    // Another build prunes without them.
    temp.exec(&format!("DELETE FROM events WHERE id = {}", ids[2]));
    assert!(!current(&temp));
    catch_up(&temp, 100);
    assert_eq!(fact_ids(&temp), ids[3..]);

    temp.exec(&format!("DELETE FROM events WHERE worker_id = '{W}'"));
    assert!(!current(&temp));
    catch_up(&temp, 100);
    assert!(fact_ids(&temp).is_empty() && current(&temp));

    launch(&temp, 50, "again");
    catch_up(&temp, 100);
    temp.store.write_blocking(|tx, _| tx.events().delete_by_worker(W)).expect("deletes");
    assert_eq!(temp.count("SELECT count(*) FROM conversation_list_facts"), 0);
    assert_eq!(temp.count("SELECT count(*) FROM conversation_list_marks"), 0);
}

#[test]
fn a_patched_row_keeps_facts_that_match_it() {
    let temp = TempStore::new();
    let id = launch(&temp, 10, "a");
    catch_up(&temp, 100);
    let text =
        json!({"type": "message", "role": "assistant", "blocks": [{"type": "text", "text": "no call"}]}).to_string();
    temp.store.write_blocking(move |tx, _| tx.events().patch_payload(id, &text)).expect("patches");
    assert!(fact_ids(&temp).is_empty());
    let page = temp
        .store
        .read_blocking(|tx| {
            tx.events().list(&EventQuery {
                worker_id: W.into(),
                since: 0,
                limit: 10,
                order: EventOrder::Asc,
                before_id: None,
                after_id: None,
            })
        })
        .expect("reads");
    assert_eq!(page.len(), 1, "the log itself is untouched");
}
