//! Writes: on the rev the user saw, and the 409 that says why not.

use eos_domain::inbox::ItemKind;
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use serde_json::json;

use crate::rig::{Rig, new_item};

#[tokio::test(flavor = "multi_thread")]
async fn the_second_answer_hears_who_answered_and_a_stale_rev_what_changed() {
    let rig = Rig::new().await;
    let item = rig.open(new_item(ItemKind::RoutineAlert, "rt-1")).await;
    let path = format!("/api/inbox/{}/answer", item.id);
    let body = json!({"rev": 1, "answer": {"kind": "routine_alert", "choice": "resume"}});
    let phone = Caller::Phone { grant: Tier::High, mutate: true };
    let (status, answered) = rig.ask_as(phone, Method::Post, &path, Some(body.clone())).await;
    assert_eq!((status, answered["state"].as_str(), answered["rev"].as_i64()), (200, Some("answered"), Some(2)));
    let (status, refused) = rig.ask(Method::Post, &path, Some(body)).await;
    assert_eq!(
        (status, refused),
        (409, json!({"error": "already answered", "state": "answered", "answeredBy": "phone"}))
    );

    let (_, detail) = rig.ask(Method::Get, &format!("/api/inbox/{}", item.id), None).await;
    assert_eq!(detail["answer"], json!({"kind": "routine_alert", "choice": "resume"}));
    assert_eq!(detail["answeredBy"], "phone");

    let notice = rig.open(new_item(ItemKind::Notice, "rt-1")).await;
    let later = format!("/api/inbox/{}/later", notice.id);
    assert_eq!(rig.ask(Method::Post, &later, Some(json!({"until": 5_000_000}))).await.0, 200);
    let stale = json!({"rev": 1, "answer": {"kind": "notice", "choice": "dismiss"}});
    let (status, changed) = rig.ask(Method::Post, &format!("/api/inbox/{}/answer", notice.id), Some(stale)).await;
    assert_eq!((status, changed), (409, json!({"error": "changed", "rev": 2})));
    let (status, _) =
        rig.ask(Method::Post, &format!("/api/inbox/{}/discard", notice.id), Some(json!({"rev": 2}))).await;
    assert_eq!(status, 200);
    let changes = rig.temp.announced.list();
    assert!(changes.iter().all(|(topic, _)| *topic == "inbox:change"));
    assert_eq!(changes.len(), 5, "each write is announced");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_draft_keeps_edits_and_a_wrong_answer_is_refused() {
    let rig = Rig::new().await;
    let draft = rig.open(new_item(ItemKind::Draft, "rt-1")).await;
    let doc = json!({"kind": "github.review", "channel": "github", "action": "post_review",
        "parts": [{"key": "summary", "role": "summary", "text": "Looks good"}]});
    let path = format!("/api/inbox/{}/draft", draft.id);
    let (status, saved) = rig.ask(Method::Put, &path, Some(json!({"rev": 1, "doc": doc}))).await;
    assert_eq!((status, saved["rev"].as_i64()), (200, Some(2)));
    let (_, detail) = rig.ask(Method::Get, &format!("/api/inbox/{}", draft.id), None).await;
    assert_eq!(detail["working"]["parts"][0]["text"], "Looks good");
    assert_eq!(rig.ask(Method::Put, &path, Some(json!({"rev": 1, "doc": doc}))).await.0, 409);

    let answer = json!({"rev": 2, "answer": {"kind": "notice", "choice": "act"}});
    assert_eq!(rig.ask(Method::Post, &format!("/api/inbox/{}/answer", draft.id), Some(answer)).await.0, 400);
    assert_eq!(rig.ask(Method::Post, &format!("/api/inbox/{}/discard", draft.id), Some(json!({}))).await.0, 400);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_shown_item_is_answered_through_its_own_route() {
    let rig = Rig::new().await;
    rig.run_worker("w-run");
    rig.ask_permission("p-run", "w-run", 2_000).await;
    let body = json!({"rev": 1, "answer": {"kind": "notice", "choice": "act"}});
    let (status, refused) = rig.ask(Method::Post, "/api/inbox/perm:p-run/answer", Some(body)).await;
    assert_eq!(
        (status, refused),
        (409, json!({"error": "answered through its own route", "routes": ["POST /pending/p-run/decision"]}))
    );
    let (status, refused) = rig.ask(Method::Post, "/api/inbox/sugg:um-abcdefgh/discard", Some(json!({"rev": 1}))).await;
    assert_eq!(status, 409);
    assert_eq!(
        refused["routes"],
        json!(["POST /api/user-memories/um-abcdefgh/approve", "POST /api/user-memories/um-abcdefgh/dismiss"])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_everything_and_resume_answer_the_switch_and_announce_it() {
    let rig = Rig::new().await;
    let mut halts = rig.runtime.kernel.bus.subscribe("inbox:halt", 8);
    let (status, on) = rig.ask(Method::Post, "/api/eos/halt", None).await;
    assert_eq!((status, on), (200, json!({"on": true, "since": 1_000_000})));
    assert_eq!(rig.ask(Method::Get, "/api/eos/halt", None).await.1, json!({"on": true, "since": 1_000_000}));
    let (status, off) = rig.ask(Method::Post, "/api/eos/resume", None).await;
    assert_eq!((status, off), (200, json!({"on": false})));
    rig.runtime.kernel.bus.flush().await;
    let mut heard = Vec::new();
    while let Ok(Ok(event)) = tokio::time::timeout(std::time::Duration::from_millis(500), halts.recv()).await {
        heard.push(event.payload_as::<serde_json::Value>().expect("json"));
    }
    assert_eq!(heard, [json!({"on": true, "since": 1_000_000}), json!({"on": false})]);
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_on_an_alert_names_the_recipients_to_confirm_first_and_leaves_it_open() {
    let rig = Rig::new().await;
    let mut alert = new_item(ItemKind::RoutineAlert, "rt-1");
    alert.payload = json!({"reason": "target_refused"});
    let item = rig.open(alert).await;
    let me = serde_json::from_value(json!({"id": "me", "kind": "me", "channel": "push"})).expect("a recipient");
    rig.control.refuse_resume("rt-1", Some(eos_core::routine::ResumeRefusal { recipients: vec![me] }));
    let path = format!("/api/inbox/{}/answer", item.id);
    let body = json!({"rev": 1, "answer": {"kind": "routine_alert", "choice": "resume"}});
    let (status, refused) = rig.ask(Method::Post, &path, Some(body.clone())).await;
    assert_eq!(status, 409);
    assert_eq!(
        refused,
        json!({"error": "Confirm where this routine sends before it resumes.", "code": "recipients_unconfirmed",
               "recipients": [{"id": "me", "label": "you"}]})
    );
    let (_, open) = rig.ask(Method::Get, &format!("/api/inbox/{}", item.id), None).await;
    assert_eq!((&open["item"]["state"], &open["item"]["rev"]), (&json!("open"), &json!(1)));

    rig.control.refuse_resume("rt-1", None);
    assert_eq!(rig.ask(Method::Post, &path, Some(body)).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_question_withdrawn_with_its_routine_wakes_its_asker() {
    use eos_core::agent::UserQuestions;

    let rig = Rig::new().await;
    rig.run_worker("w-run");
    let (questions, asked) = (
        rig.questions.clone(),
        json!({"question": "Which branch?", "header": "Branch", "multiSelect": false, "options": [{"label": "main"}]}),
    );
    let asked = vec![serde_json::from_value(asked).expect("a question")];
    let asker = tokio::spawn(async move { questions.ask("w-run", None, asked).await });
    let mut opened = Vec::new();
    for _ in 0..200 {
        opened = rig.temp.port().read(|tx| tx.inbox_items().waiting_of_routine("rt-1")).await.expect("reads");
        if !opened.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(opened.len(), 1, "the question waits in Needs you");

    rig.temp.port().write(|tx, out| eos_inbox::withdraw_routine_in(tx, out, 2_000_000, "rt-1")).await.expect("writes");
    let heard = tokio::time::timeout(std::time::Duration::from_secs(5), asker).await.expect("woken").expect("ends");
    let heard = heard.expect("an answer");
    assert_eq!(heard.get("Which branch?"), Some(&json!(eos_inbox::WITHDRAWN)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_full_sync_domain_opens_one_notice_a_day() {
    let rig = Rig::new().await;
    let full: eos_runtime::bus::Topic<eos_contracts::SyncFull> = eos_runtime::bus::Topic::new("sync:full");
    let count = || rig.temp.count("SELECT COUNT(*) FROM inbox_items WHERE kind = 'notice' AND producer = 'sync'");
    rig.runtime.kernel.bus.publish(&full, &eos_contracts::SyncFull { domain: "memory".into() });
    for _ in 0..200 {
        if count() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(count(), 1);
    rig.runtime.kernel.bus.publish(&full, &eos_contracts::SyncFull { domain: "memory".into() });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(count(), 1, "the same day's notice is brought up to date");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_item_put_off_until_soon_wakes_the_sweeper_so_it_comes_back_on_time() {
    let rig = Rig::new().await;
    let notice = rig.open(new_item(ItemKind::Notice, "rt-1")).await;
    let soon = 1_000_000 + 60_000;
    let later = format!("/api/inbox/{}/later", notice.id);
    assert_eq!(rig.ask(Method::Post, &later, Some(json!({"until": soon}))).await.0, 200);
    for _ in 0..400 {
        if rig.sleeper.pending().iter().any(|wait| (1..=60_000).contains(wait)) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    panic!("the sweeper waits for the item: {:?}", rig.sleeper.pending());
}
