//! Named queries and the Live parts they feed: read only when the kept
//! design declares them, for the surface's own routine, with arguments the
//! core fills from the stored issue; a failing query gives the last good
//! drawing back, marked not current.

use eos_core::store::StoredIssue;
use eos_runtime::http::Method;
use eos_surface::{IssueKind, Level, Place, VersionStatus};
use serde_json::json;

use crate::rig::{Rig, issue, surface, version};

const TEMPLATE: &str = r#"<section part="desk"><h1>{title}</h1><Live part="waiting" query="probe.count" args={{"of": "{kind}"}}><p>{query.count} wait</p></Live></section>"#;

fn body(queries: &[&str]) -> String {
    json!({
        "template": TEMPLATE,
        "style": "",
        "contract": {"type": "object", "fields": {"title": {"type": "text", "max": 40}, "kind": {"type": "text", "max": 20}}},
        "queries": queries,
        "sample": {"title": "Desk", "kind": "reviews"},
    })
    .to_string()
}

async fn desk(rig: &Rig, kind: &str, queries: &[&str]) {
    let mut s = surface("sf-desk", "rt-1", Level::Page, Place::RoutinePage, 1);
    s.current_version = Some(1);
    let mut v = version("sf-desk", 1, VersionStatus::Kept);
    v.body_json = body(queries);
    let page = StoredIssue {
        version: Some(1),
        kind: IssueKind::Page,
        body_json: json!({"data": {"title": "<b>Desk</b>", "kind": kind}}).to_string(),
        ..issue("si-1", "sf-desk")
    };
    rig.seed(vec![s], vec![v], vec![page]).await;
}

#[tokio::test]
async fn a_live_part_is_drawn_with_its_query_read_for_the_surfaces_routine() {
    let rig = Rig::new().await;
    desk(&rig, "reviews", &["probe.count"]).await;
    let (status, part) = rig.ask(Method::Get, "/api/surfaces/sf-desk/issues/si-1/parts/waiting", None).await;
    assert_eq!(status, 200, "{part}");
    assert_eq!(part["current"], true);
    assert_eq!(part["topics"], json!(["probe:change"]));
    let html = part["html"].as_str().expect("html");
    assert!(html.starts_with("<div class=\"eos-live\"") && html.ends_with("</div>"), "{html}");
    assert!(html.contains("<p>1 wait</p>"), "{html}");
    assert!(!html.contains("Desk"), "only the part is drawn");
    let read = rig.read.lock().expect("read").clone();
    assert_eq!(read[0].routine_id.as_deref(), Some("rt-1"));
    assert_eq!(read[0].args, json!({"of": "reviews"}), "the arguments come from the stored issue");

    let (status, answer) =
        rig.ask(Method::Get, "/api/surfaces/sf-desk/queries/probe.count?args=%7B%22of%22%3A%22x%22%7D", None).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer, json!({"queryId": "probe.count", "answer": {"count": 2}, "topics": ["probe:change"]}));
    let (status, _) =
        rig.ask(Method::Get, "/api/surfaces/sf-desk/queries/probe.count?args=%7B%22of%22%3A1%7D", None).await;
    assert_eq!(status, 400, "arguments are typed by the query");
    let (status, _) = rig.ask(Method::Get, "/api/surfaces/sf-desk/issues/si-1/parts/desk", None).await;
    assert_eq!(status, 404, "a part that is not live");
}

#[tokio::test]
async fn a_query_the_design_does_not_declare_is_never_read() {
    let rig = Rig::new().await;
    desk(&rig, "reviews", &["probe.count"]).await;
    rig.temp.exec("UPDATE surface_defs SET current_version = NULL");
    let (status, _) = rig.ask(Method::Get, "/api/surfaces/sf-desk/queries/probe.count", None).await;
    assert_eq!(status, 404, "a surface with no kept design reads nothing");
    let (status, _) = rig.ask(Method::Get, "/api/surfaces/sf-desk/queries/needs_you.summary", None).await;
    assert_eq!(status, 404);
    assert!(rig.read.lock().expect("read").is_empty());
}

#[tokio::test]
async fn a_failing_query_gives_the_last_good_part_back_marked_not_current() {
    let rig = Rig::new().await;
    desk(&rig, "reviews", &["probe.count"]).await;
    let path = "/api/surfaces/sf-desk/issues/si-1/parts/waiting";
    let (_, good) = rig.ask(Method::Get, path, None).await;
    rig.temp.exec(r#"UPDATE surface_issues SET body = '{"data":{"title":"Desk","kind":"broken"}}' WHERE id = 'si-1'"#);
    let (status, stale) = rig.ask(Method::Get, path, None).await;
    assert_eq!(status, 200, "{stale}");
    assert_eq!((stale["current"].clone(), stale["html"].clone()), (json!(false), good["html"].clone()));
    let never = StoredIssue {
        id: "si-2".into(),
        version: Some(1),
        kind: IssueKind::Page,
        body_json: json!({"data": {"title": "Desk", "kind": "broken"}}).to_string(),
        ..issue("si-2", "sf-desk")
    };
    rig.seed(vec![], vec![], vec![never]).await;
    let (status, _) = rig.ask(Method::Get, "/api/surfaces/sf-desk/issues/si-2/parts/waiting", None).await;
    assert_eq!(status, 502, "a part never drawn has nothing to give back");
}
