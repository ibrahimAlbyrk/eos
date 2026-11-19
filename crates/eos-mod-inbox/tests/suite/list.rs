//! The list: Needs you's order, its counts, pages, and what is shown without
//! being kept.

use eos_domain::inbox::ItemKind;
use eos_runtime::http::Method;
use serde_json::{Value, json};

use crate::rig::{Rig, new_item};

fn ids(answer: &Value) -> Vec<String> {
    let items = answer["items"].as_array().expect("items");
    items.iter().map(|item| item["id"].as_str().expect("an id").to_owned()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn items_come_open_before_later_then_loudest_then_newest_with_the_counts_of_all() {
    let rig = Rig::new().await;
    let notice = rig.open(new_item(ItemKind::Notice, "rt-1")).await;
    let alert = rig.open(new_item(ItemKind::RoutineAlert, "rt-1")).await;
    let suggestion = rig.open(new_item(ItemKind::Suggestion, "rt-2")).await;
    let aside = rig.open(new_item(ItemKind::RoutineAlert, "rt-2")).await;
    let newer_notice = rig.open(new_item(ItemKind::Notice, "rt-2")).await;
    let (status, _) = rig.ask(Method::Post, &format!("/api/inbox/{}/later", aside.id), Some(json!({}))).await;
    assert_eq!(status, 200);

    let (status, answer) = rig.ask(Method::Get, "/api/inbox", None).await;
    assert_eq!(status, 200);
    assert_eq!(
        ids(&answer),
        [alert.id.as_str(), newer_notice.id.as_str(), notice.id.as_str(), suggestion.id.as_str(), aside.id.as_str()]
    );
    assert_eq!(
        answer["counts"],
        json!({
            "open": 4,
            "later": 1,
            "byKind": {"notice": 2, "routine_alert": 2, "suggestion": 1},
            "byRoutine": {"rt-1": 2, "rt-2": 3},
        })
    );
    assert_eq!(answer["agentsWaiting"], 0);
    assert!(answer.get("nextCursor").is_none(), "one page");
    let first = &answer["items"][0];
    assert_eq!(
        *first,
        json!({
            "id": alert.id, "kind": "routine_alert", "state": "open", "attention": "interrupt", "routineId": "rt-1",
            "title": "Review of #482", "summary": "Two comments", "rev": 1,
            "createdAt": alert.created_at, "updatedAt": alert.created_at,
        })
    );

    let (_, of_routine) = rig.ask(Method::Get, "/api/inbox?routineId=rt-2", None).await;
    assert_eq!(ids(&of_routine), [newer_notice.id.as_str(), suggestion.id.as_str(), aside.id.as_str()]);
    let (_, later) = rig.ask(Method::Get, "/api/inbox?state=later", None).await;
    assert_eq!(ids(&later), [aside.id.as_str()]);
    assert_eq!(rig.ask(Method::Get, "/api/inbox?state=closed", None).await.0, 400);
    assert_eq!(rig.ask(Method::Get, "/api/inbox?cursor=nonsense", None).await.0, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_long_list_comes_in_pages_of_a_hundred() {
    let rig = Rig::new().await;
    let mut opened = Vec::new();
    for n in 0..130 {
        let routine = format!("rt-{}", n % 7);
        opened.push(rig.open(new_item(ItemKind::Notice, &routine)).await.id);
    }
    rig.run_worker("w-run");
    rig.ask_permission("p-run", "w-run", 1_000_050).await;
    opened.reverse();
    // The run's ask interrupts, the notices are digested: it comes first.
    opened.insert(0, "perm:p-run".to_owned());

    let (_, first) = rig.ask(Method::Get, "/api/inbox", None).await;
    assert_eq!(ids(&first), opened[..100]);
    let cursor = first["nextCursor"].as_str().expect("another page");
    let (_, second) = rig.ask(Method::Get, &format!("/api/inbox?cursor={cursor}"), None).await;
    assert_eq!(ids(&second), opened[100..]);
    assert!(second.get("nextCursor").is_none());
    assert_eq!(first["counts"]["open"], 131);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_runs_ask_and_a_suggestion_are_shown_and_agents_chats_are_one_count() {
    let rig = Rig::new().await;
    rig.run_worker("w-run");
    rig.ask_permission("p-run", "w-run", 2_000).await;
    rig.ask_permission("p-chat", "w-chat", 3_000).await;
    rig.question_from("w-chat");
    rig.question_from("w-other");
    rig.question_from("w-run");
    rig.suggest("um-abcdefgh", 4_000.0);
    let draft = rig.open(new_item(ItemKind::Notice, "rt-1")).await;

    let (_, answer) = rig.ask(Method::Get, "/api/inbox", None).await;
    assert_eq!(ids(&answer), ["perm:p-run", &draft.id, "sugg:um-abcdefgh"]);
    assert_eq!(answer["agentsWaiting"], 3, "the chat's ask and the questions of two chats");
    assert_eq!(
        answer["items"][0],
        json!({
            "id": "perm:p-run", "kind": "permission", "state": "open", "attention": "interrupt",
            "routineId": "rt-1", "runId": "rn-1", "title": "Allow Bash?", "summary": "cargo test", "rev": 1,
            "createdAt": 2_000, "updatedAt": 2_000,
        })
    );
    assert_eq!(answer["items"][2]["kind"], "about_you");
    assert_eq!(answer["items"][2]["attention"], "silent");
    assert_eq!(answer["counts"]["byKind"], json!({"about_you": 1, "notice": 1, "permission": 1}));
    assert_eq!(answer["counts"]["byRoutine"], json!({"rt-1": 2}));

    let (_, of_routine) = rig.ask(Method::Get, "/api/inbox?routineId=rt-1", None).await;
    assert_eq!(ids(&of_routine), ["perm:p-run", &draft.id]);
    let (_, later) = rig.ask(Method::Get, "/api/inbox?state=later", None).await;
    assert!(ids(&later).is_empty(), "a shown item is always open");

    let (status, ask) = rig.ask(Method::Get, "/api/inbox/perm:p-run", None).await;
    assert_eq!(status, 200);
    assert_eq!(ask["payload"]["offers"], json!(["allow_once", "deny"]), "never always: it would widen every chat");
    assert_eq!(ask["payload"]["input"], json!({"command": "cargo test"}));
    let (status, suggestion) = rig.ask(Method::Get, "/api/inbox/sugg%3Aum-abcdefgh", None).await;
    assert_eq!(status, 200);
    assert_eq!(suggestion["payload"]["memory"]["text"], "Prefers short reviews");
    assert_eq!(rig.ask(Method::Get, "/api/inbox/perm:p-chat", None).await.0, 404, "a chat's ask is no item");
    assert_eq!(rig.ask(Method::Get, "/api/inbox/nd-missing", None).await.0, 404);
}
