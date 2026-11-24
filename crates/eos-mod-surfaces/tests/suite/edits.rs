//! Edits in place: only what the contract marks `edit`, on the revision the
//! reader saw, each a revision with its before and after, and told to memory
//! after commit; what the reader opened is told to memory too.

use eos_core::experience::SurfaceSignalKind;
use eos_core::store::StoredIssue;
use eos_runtime::http::Method;
use eos_surface::{IssueKind, Level, Place, VersionStatus};
use eos_testkit::FeedbackCall;
use serde_json::{Value, json};

use crate::rig::{Rig, issue, surface, version};

const FIELDS: &str = "/api/surfaces/sf-desk/issues/si-1/fields";

async fn desk(rig: &Rig) {
    let mut s = surface("sf-desk", "rt-1", Level::Page, Place::RoutinePage, 1);
    s.current_version = Some(1);
    let mut v = version("sf-desk", 1, VersionStatus::Kept);
    v.body_json = json!({
        "template": "<section part=\"desk\"><h1>{title}</h1><ul each=\"stories\" as=\"s\" part=\"stories\"><li>{s.title}</li></ul></section>",
        "style": "",
        "contract": {"type": "object", "fields": {
            "title": {"type": "text", "max": 12, "edit": true},
            "note": {"type": "text", "max": 40},
            "stories": {"type": "list", "min": 1, "max": 5, "edit": true, "of": {"type": "object", "fields": {
                "title": {"type": "text", "max": 40, "edit": true}}}}}},
        "sample": {"title": "Desk", "note": "n", "stories": [{"title": "a"}]},
    })
    .to_string();
    let data = json!({"title": "Desk", "note": "kept", "stories": [{"title": "one"}, {"title": "two"}]});
    let page = StoredIssue {
        version: Some(1),
        kind: IssueKind::Page,
        body_json: json!({ "data": data }).to_string(),
        ..issue("si-1", "sf-desk")
    };
    rig.seed(vec![s], vec![v], vec![page]).await;
}

async fn edit(rig: &Rig, body: Value) -> (u16, Value) {
    rig.ask(Method::Put, FIELDS, Some(body)).await
}

async fn edits(rig: &Rig) -> Vec<(i64, String, String, String, String)> {
    let found = rig.temp.port().read(|tx| tx.surface_edits().of_issue("si-1")).await.expect("reads");
    found.into_iter().map(|e| (e.rev, e.op, e.path, e.before_json, e.after_json)).collect()
}

#[tokio::test]
async fn an_editable_field_takes_plain_text_as_a_new_revision_with_its_before_and_after() {
    let rig = Rig::new().await;
    desk(&rig).await;
    let (status, issue) = edit(&rig, json!({"baseRev": 1, "op": "set", "path": "title", "value": "My desk"})).await;
    assert_eq!(status, 200, "{issue}");
    assert_eq!((issue["issue"]["rev"].clone(), issue["body"]["data"]["title"].clone()), (json!(2), json!("My desk")));
    let (status, _) =
        edit(&rig, json!({"baseRev": 2, "op": "set", "path": "stories.1.title", "value": "Second"})).await;
    assert_eq!(status, 200);
    assert_eq!(
        edits(&rig).await,
        vec![
            (2, "set".into(), "title".into(), "\"Desk\"".into(), "\"My desk\"".into()),
            (3, "set".into(), "stories.1.title".into(), "\"two\"".into(), "\"Second\"".into()),
        ]
    );
    let announced: Vec<String> =
        rig.temp.announced.list().into_iter().filter(|(t, _)| *t == "surfaces:issue").map(|(_, p)| p).collect();
    assert_eq!(announced.len(), 2);
    let FeedbackCall::Surface(told) = rig.feedback.calls()[0].clone() else { panic!("a surface signal") };
    assert_eq!(
        (told.kind, told.at.as_deref(), told.run_id.as_deref()),
        (SurfaceSignalKind::Edited, Some("title"), Some("rn-1"))
    );
    assert_eq!((told.before, told.after), (Some(json!("Desk")), Some(json!("My desk"))));
}

#[tokio::test]
async fn only_what_the_contract_allows_is_edited_and_only_on_the_revision_seen() {
    let rig = Rig::new().await;
    desk(&rig).await;
    for (body, status) in [
        (json!({"baseRev": 1, "op": "set", "path": "note", "value": "x"}), 400),
        (json!({"baseRev": 1, "op": "set", "path": "title", "value": "far too long a title"}), 400),
        (json!({"baseRev": 1, "op": "set", "path": "title", "value": "two\nlines"}), 400),
        (json!({"baseRev": 1, "op": "set", "path": "nothing", "value": "x"}), 400),
        (json!({"baseRev": 1, "op": "set", "path": "title"}), 400),
        (json!({"baseRev": 1, "op": "rewrite", "path": "title"}), 400),
        (json!({"baseRev": 9, "op": "set", "path": "title", "value": "x"}), 409),
    ] {
        assert_eq!(edit(&rig, body.clone()).await.0, status, "{body}");
    }
    assert!(edits(&rig).await.is_empty());
    assert!(rig.feedback.calls().is_empty(), "nothing told for a refused edit");
}

#[tokio::test]
async fn an_editable_list_is_reordered_or_shortened_down_to_its_minimum() {
    let rig = Rig::new().await;
    desk(&rig).await;
    let (_, moved) = edit(&rig, json!({"baseRev": 1, "op": "move", "path": "stories", "from": 1, "to": 0})).await;
    assert_eq!(moved["body"]["data"]["stories"], json!([{"title": "two"}, {"title": "one"}]));
    let (_, removed) = edit(&rig, json!({"baseRev": 2, "op": "remove", "path": "stories", "from": 1})).await;
    assert_eq!(removed["body"]["data"]["stories"], json!([{"title": "two"}]));
    let (status, _) = edit(&rig, json!({"baseRev": 3, "op": "remove", "path": "stories", "from": 0})).await;
    assert_eq!(status, 400, "a list keeps its minimum");
}

#[tokio::test]
async fn what_the_reader_opened_is_told_to_memory_first_part_first() {
    let rig = Rig::new().await;
    desk(&rig).await;
    let report = json!({"parts": [{"part": "stories", "index": 1}, {"part": "desk"}], "links": [{"part": "stories", "index": 0}]});
    let (status, _) = rig.ask(Method::Post, "/api/surfaces/sf-desk/issues/si-1/read", Some(report)).await;
    assert_eq!(status, 200);
    let told: Vec<(SurfaceSignalKind, Option<String>, Option<u32>)> = rig
        .feedback
        .calls()
        .into_iter()
        .map(|call| match call {
            FeedbackCall::Surface(s) => (s.kind, s.at, s.index),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(
        told,
        vec![
            (SurfaceSignalKind::ReadFirst, Some("stories".into()), Some(1)),
            (SurfaceSignalKind::Opened, Some("desk".into()), None),
            (SurfaceSignalKind::Opened, Some("stories".into()), Some(0)),
        ]
    );
    let (status, _) = rig.ask(Method::Post, "/api/surfaces/sf-other/issues/si-1/read", Some(json!({}))).await;
    assert_eq!(status, 404);
}
