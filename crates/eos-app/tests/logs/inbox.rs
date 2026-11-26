//! Needs you: a held mail draft to a planted recipient, the user's edit of it, its send,
//! and a sent delivery whose receipt names a planted link. The log tells the send and the
//! edit by id and counts; no draft text, edit, recipient or receipt reaches it.

use eos_app::App;
use eos_contracts::{ActionClass, RoutineKind, RoutineState, VersionAuthor, VersionStatus};
use eos_core::store::{StoredDelivery, StoredRoutine, StoredVersion};
use eos_domain::inbox::ItemKind;
use eos_domain::run_scope::Trust;
use eos_inbox::{NewItem, Opening, open_in};
use eos_runtime::http::Method;
use eos_testkit::{FakeRoutineControl, FakeTimeZone, SeqIds};
use serde_json::{Value, json};

use crate::{Area, rig};

const DRAFT: &str = "PLANTED-draft-osprey-lantern";
const EDIT: &str = "PLANTED-edit-kestrel-anchor";
const RECIPIENT: &str = "planted.recipient@example.org";
const RECEIPT: &str = "https://mail.example.org/sent/PLANTED-receipt-plover";

fn mail(paragraph: &str) -> Value {
    json!({"kind": "mail", "channel": "mail", "action": "send", "parts": [
        {"key": "subject", "role": "subject", "text": "Weekly digest"},
        {"key": "p:1", "role": "paragraph", "text": paragraph},
        {"key": "to:boss", "role": "recipient", "text": RECIPIENT},
    ]})
}

/// Routine `rt-log`, paused, whose Goes to the user confirmed: the digest to the planted
/// recipient.
async fn routine(app: &App) {
    let agent = json!({"key": "editor", "name": "Editor", "lead": true, "brief": "Write.", "model": "sonnet",
                       "effort": "medium", "tools": {}, "readsOutside": false, "workspace": "none"});
    let blueprint = json!({
        "format": 1, "name": "Weekly digest", "summary": "Writes the weekly digest.", "icon": "mail",
        "kind": "standing",
        "takes": {"kind": "github.pull_request", "label": "pull request", "placeholder": "#470",
                  "empty": "required", "many": true},
        "options": [],
        "when": {"on": [{"source": "github.pulls", "scope": {"repo": "acme/game"}, "events": ["opened"]}]},
        "which": {},
        "who": {"depth": "solo", "agents": [agent], "checker": {"model": "sonnet", "effort": "high"}},
        "how": {"checks": [], "format": "mail", "checkAgent": true},
        "makes": {"kind": "mail", "description": "A mail."},
        "goesTo": [{"id": "boss", "kind": "fixed", "channel": "mail", "address": RECIPIENT}],
        "freedom": {"rung": "draft"},
        "limits": {"perRunMinutes": 30, "parallel": 1},
    });
    let version = StoredVersion {
        id: "rv-log".into(),
        routine_id: "rt-log".into(),
        parent_id: None,
        status: VersionStatus::Kept,
        author: VersionAuthor::User,
        note: None,
        format: 1,
        hash: "h".into(),
        blueprint: blueprint.to_string(),
        no_trial: false,
        trust: Trust::Trusted,
        device: None,
        created_at: 1,
    };
    let routine = StoredRoutine {
        id: "rt-log".into(),
        slug: "weekly-digest".into(),
        name: "Weekly digest".into(),
        kind: RoutineKind::Standing,
        state: RoutineState::Paused,
        paused_reason: Some("user".into()),
        head_version_id: Some("rv-log".into()),
        origin: "hand".into(),
        task_key: None,
        agents_may_start: false,
        failure_streak: 0,
        created_at: 1,
        updated_at: 1,
        changed_at: 1,
        started_at: None,
        deleted_at: None,
    };
    app.store()
        .write(move |tx, _| {
            tx.routines().insert(&routine)?;
            tx.routine_versions().insert(&version)
        })
        .await
        .expect("written");
}

/// The draft the gate would hold for routine `rt-log`'s run.
async fn hold(app: &App) -> String {
    routine(app).await;
    let draft = NewItem {
        kind: ItemKind::Draft,
        producer: "inbox".into(),
        routine_id: Some("rt-log".into()),
        run_id: Some("rn-log".into()),
        subject_key: None,
        title: "Weekly digest".into(),
        summary: "It waits for you to send it.".into(),
        payload: json!({
            "doc": mail(DRAFT),
            "targets": [{"recipientId": "boss", "place": {"address": RECIPIENT}}],
            "rung": "draft",
            "untrusted": false,
        }),
        by_hand: true,
    };
    let item = app
        .store()
        .write(move |tx, out| {
            let (ids, zone, control) = (SeqIds::new(), FakeTimeZone::new("UTC", 0), FakeRoutineControl::new());
            open_in(tx, out, &Opening { now: 1, ids: &ids, zone: &zone, control: &control }, draft)
        })
        .await
        .expect("held");
    item.id
}

/// A delivery that went out, with what the service left.
async fn sent_delivery(app: &App) -> String {
    let row = StoredDelivery {
        id: "dl-log-sent".into(),
        item_id: None,
        run_id: "rn-log".into(),
        routine_id: "rt-log".into(),
        channel: "mail".into(),
        action: "send".into(),
        target_ref: "boss".into(),
        target: json!({"recipientId": "boss", "place": {"address": RECIPIENT}}).to_string(),
        body: mail(DRAFT).to_string(),
        body_hash: "h".into(),
        class: ActionClass::Speak,
        mode: "approved".into(),
        state: "sent".into(),
        send_at: Some(1),
        attempts: 1,
        next_attempt_at: None,
        last_error_kind: None,
        partial: None,
        receipt: Some(json!({"id": "rc-1", "url": RECEIPT}).to_string()),
        sent_at: Some(2),
        undo_until: None,
        undone_at: None,
        approved_at: Some(1),
        created_at: 1,
        updated_at: 2,
    };
    let id = row.id.clone();
    app.store().write(move |tx, _| tx.inbox_deliveries().insert(&row)).await.expect("written");
    id
}

pub(crate) async fn steps(app: &App) -> Area {
    let item = hold(app).await;
    let (status, saved) =
        rig::call(app, Method::Put, &format!("/api/inbox/{item}/draft"), Some(json!({"rev": 1, "doc": mail(EDIT)})))
            .await;
    assert_eq!(status, 200, "{saved}");
    let (status, sent) =
        rig::call(app, Method::Post, &format!("/api/inbox/{item}/send"), Some(json!({"rev": 2}))).await;
    assert_eq!(status, 200, "{sent}");
    let delivery = sent_delivery(app).await;
    let (status, read) = rig::call(app, Method::Get, &format!("/api/inbox/deliveries/{delivery}"), None).await;
    assert_eq!((status, read["receiptUrl"].as_str()), (200, Some(RECEIPT)));

    let planted = [DRAFT, EDIT, RECIPIENT, RECEIPT, "PLANTED-receipt-plover"];
    let told = ["a draft was sent", "a result was edited before it went out", "changed=1"];
    Area { planted: planted.map(str::to_owned).to_vec(), told: told.map(str::to_owned).to_vec() }
}
