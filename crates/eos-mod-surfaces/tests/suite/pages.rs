//! A routine's Page: a run fills it with data checked against the version it
//! fills, its images are taken in once, and the issue is drawn in the frame,
//! for the phone, as a file to share and as mail. Three refused fills fall
//! back to a plain View, and two fallbacks in a row ask for a redesign.

use std::time::Duration;

use eos_core::store::StoredSurfaceVersion;
use eos_runtime::http::Method;
use eos_runtime::router::Router;
use eos_surface::{IssueKind, IssueStatus, Level, MadeBy, Place, VersionStatus};
use serde_json::{Value, json};

use crate::rig::{Rig, surface};

const PAPER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../eos-surface/tests/morning-paper");

fn file(name: &str) -> String {
    std::fs::read_to_string(format!("{PAPER}/{name}")).expect("fixture")
}

fn json_file(name: &str) -> Value {
    serde_json::from_str(&file(name)).expect("json")
}

fn design_body() -> Value {
    json!({"template": file("template.html"), "style": file("style.css"), "contract": json_file("contract.json"),
           "uses": ["surface.feedback"], "sample": json_file("sample.json")})
}

fn page_version(version: i64, status: VersionStatus, kept_at: Option<i64>, body: &Value) -> StoredSurfaceVersion {
    StoredSurfaceVersion {
        surface_id: "sf-paper".into(),
        version,
        status,
        base_version: None,
        made_by: MadeBy::Designer,
        run_id: None,
        note: String::new(),
        body_json: body.to_string(),
        body_bytes: 0,
        checks_json: "{}".into(),
        created_at: 0,
        kept_at,
    }
}

/// The paper's routine with one run started at 1,000 whose lead is `w-lead`.
async fn paper(rig: &Rig, kind: &str) {
    rig.run_worker("rt-1", "Morning Paper", "rn-1", kind, "w-lead");
    rig.temp.exec("UPDATE runs SET started_at = 1000 WHERE id = 'rn-1'");
    let mut s = surface("sf-paper", "rt-1", Level::Page, Place::RoutinePage, 1);
    s.title = "Morning Paper".into();
    s.current_version = Some(1);
    s.candidate_version = Some(3);
    // Version 2 was kept after the run started: the run still fills 1.
    let mut v2 = design_body();
    v2["contract"]["fields"]["title"]["max"] = json!(5);
    v2["sample"]["title"] = json!("Daily");
    rig.seed(
        vec![s],
        vec![
            page_version(1, VersionStatus::Superseded, Some(500), &design_body()),
            page_version(2, VersionStatus::Kept, Some(2000), &v2),
            page_version(3, VersionStatus::Candidate, None, &v2),
        ],
        vec![],
    )
    .await;
}

fn tools(rig: &Rig) -> std::sync::Arc<dyn eos_core::surface::SurfaceTools> {
    rig.module.tools()
}

async fn issue_of(rig: &Rig, id: &str) -> eos_core::store::StoredIssue {
    let id = id.to_owned();
    rig.temp.port().read(move |tx| tx.surface_issues().find(&id)).await.expect("reads").expect("the issue")
}

async fn settled(rig: &Rig, id: &str) -> eos_core::store::StoredIssue {
    for _ in 0..200 {
        let issue = issue_of(rig, id).await;
        if issue.status != IssueStatus::Preparing {
            return issue;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the issue's images never settled");
}

fn issue_id(line: &str) -> String {
    line.split_whitespace().nth(1).expect("an issue id").to_owned()
}

#[tokio::test]
async fn a_run_fills_the_version_kept_when_it_started_and_its_images_settle_once() {
    let rig = Rig::new().await;
    paper(&rig, "standing").await;
    let asked = tools(&rig).fill_page("w-lead", Value::Null).await.expect("the contract");
    assert!(asked.starts_with("Version 1 of this page takes data of this contract"), "{asked}");
    let line = tools(&rig).fill_page("w-lead", json_file("sample.json")).await.expect("accepted");
    assert!(line.ends_with("accepted · 2 starred · 3 stories · 1 image fetching"), "{line}");
    let issue = settled(&rig, &issue_id(&line)).await;
    assert_eq!(
        (issue.kind, issue.version, issue.seq, issue.status),
        (IssueKind::Page, Some(1), Some(1), IssueStatus::Ready)
    );
    assert!(issue.images_json.contains(&"a".repeat(64)), "{}", issue.images_json);
    assert_eq!(rig.images.taken().len(), 1);
    // The same run filling again makes a new revision of its issue.
    let again = tools(&rig).fill_page("w-lead", json_file("issue-2.json")).await.expect("accepted");
    assert_eq!(issue_id(&again), issue.id);
    assert_eq!(issue_of(&rig, &issue.id).await.rev, 2);
}

#[tokio::test]
async fn a_trial_fills_the_open_candidate_with_no_number() {
    let rig = Rig::new().await;
    paper(&rig, "trial").await;
    let refused = tools(&rig).fill_page("w-lead", json_file("issue-1.json")).await.expect_err("title too long for v3");
    assert!(refused.to_string().contains("title: is 17 characters, max 5"), "{refused}");
    let mut short = json_file("issue-1.json");
    short["title"] = json!("Daily");
    let line = tools(&rig).fill_page("w-lead", short).await.expect("accepted");
    let issue = issue_of(&rig, &issue_id(&line)).await;
    assert_eq!((issue.version, issue.seq, issue.trial), (Some(3), None, true));
}

#[tokio::test]
async fn three_refused_fills_fall_back_to_a_plain_view_and_two_fallbacks_ask_for_a_redesign() {
    let rig = Rig::new().await;
    paper(&rig, "standing").await;
    let bad = json!({"title": 3});
    for left in ["2 more refused fills", "1 more refused fill "] {
        let refused = tools(&rig).fill_page("w-lead", bad.clone()).await.expect_err("refused");
        assert!(refused.to_string().contains(left.trim_end()), "{refused}");
        assert!(refused.to_string().contains("stories: is required"), "{refused}");
    }
    let line = tools(&rig).fill_page("w-lead", bad.clone()).await.expect("falls back");
    assert!(line.contains("is shown as a plain view"), "{line}");
    let issue = issue_of(&rig, &issue_id(&line)).await;
    assert_eq!(issue.kind, IssueKind::Fallback);
    let body: Value = serde_json::from_str(&issue.body_json).expect("json");
    assert_eq!(body["view"]["title"], "Morning Paper");
    let marked = rig.temp.port().read(|tx| tx.surfaces().find("sf-paper")).await.expect("reads").expect("there");
    assert!(marked.needs_redesign_json.is_some());
    assert!(rig.cards.redesigns().is_empty(), "one fallback asks for nothing yet");
    // The next run falls back too: now the page asks for a redesign, once.
    rig.run_worker("rt-1", "Morning Paper", "rn-2", "standing", "w-lead-2");
    for _ in 0..3 {
        let _ = tools(&rig).fill_page("w-lead-2", bad.clone()).await;
    }
    assert_eq!(rig.cards.redesigns(), ["sf-paper"]);
}

#[tokio::test]
async fn a_filled_issue_is_drawn_in_its_frame_with_its_policy_and_images_only_from_its_store() {
    let rig = Rig::new().await;
    paper(&rig, "standing").await;
    let line = tools(&rig).fill_page("w-lead", json_file("sample.json")).await.expect("accepted");
    let id = issue_id(&line);
    settled(&rig, &id).await;
    let raw = Router::builder().routes(rig.module.raw_routes()).build().expect("raw router");
    let (status, headers, page) = rig.fetch(&raw, &format!("/surfaces/sf-paper/issues/{id}/page.html")).await;
    assert_eq!(status, 200);
    let csp = headers.iter().find(|(k, _)| k == "content-security-policy").map(|(_, v)| v.clone()).expect("a policy");
    assert!(
        csp.contains("connect-src 'none'") && csp.contains("img-src http://raw.eos.localhost/surfaces/sf-paper/img/")
    );
    assert!(page.contains("Printed for Ibrahim"), "the reader's first name");
    assert!(page.contains("No. 1"));
    assert!(page.contains(&format!("src=\"http://raw.eos.localhost/surfaces/sf-paper/img/{}\"", "a".repeat(64))));
    let (status, _, _) = rig.fetch(&raw, &format!("/surfaces/sf-paper/issues/{id}/page.html?version=2")).await;
    assert_eq!(status, 409, "version 2 takes a title of 5 characters at most: the issue's does not fit it");
    rig.seed(vec![], vec![page_version(4, VersionStatus::Kept, Some(3000), &design_body())], vec![]).await;
    let (status, _, _) = rig.fetch(&raw, &format!("/surfaces/sf-paper/issues/{id}/page.html?version=4")).await;
    assert_eq!(status, 200, "an issue drawn in another version its data fits");
    for (current, fits) in [(2, json!(false)), (4, json!(true)), (1, Value::Null)] {
        rig.temp.exec(&format!("UPDATE surface_defs SET current_version = {current} WHERE id = 'sf-paper'"));
        let (_, shown) = rig.ask(Method::Get, &format!("/api/surfaces/sf-paper/issues/{id}"), None).await;
        assert_eq!(shown["fitsCurrent"], fits, "today's design is offered only when the data fits it");
    }
    let (status, headers, body) = rig.fetch(&raw, &format!("/surfaces/sf-paper/img/{}", "a".repeat(64))).await;
    assert_eq!((status, body.as_str()), (200, "JPEG"));
    assert!(headers.iter().any(|(k, v)| k == "content-type" && v == "image/jpeg"));
    let (status, _, _) = rig.fetch(&raw, "/surfaces/sf-paper/img/..%2F..%2Fstate.db").await;
    assert_eq!(status, 404);
    let held = rig.module.probe_docs().hold("<p>probe</p>".into());
    let path = held.trim_start_matches("http://raw.eos.localhost");
    assert_eq!(rig.fetch(&raw, path).await.2, "<p>probe</p>");
    rig.clock.advance(61_000);
    assert_eq!(rig.fetch(&raw, path).await.0, 404, "a probe document is held a minute");
}

#[tokio::test]
async fn the_phone_the_share_file_and_the_mail_carry_no_script_and_inline_their_images() {
    let rig = Rig::new().await;
    paper(&rig, "standing").await;
    let line = tools(&rig).fill_page("w-lead", json_file("sample.json")).await.expect("accepted");
    let id = issue_id(&line);
    settled(&rig, &id).await;
    let router = &rig.runtime.router;
    let (status, _, phone) =
        rig.fetch(router, &format!("/api/surfaces/sf-paper/issues/{id}/document?mode=phone")).await;
    assert_eq!(status, 200);
    assert!(!phone.contains("<script") && phone.contains("src=\"data:image/jpeg;base64,SlBFRw==\""));
    assert!(phone.contains(&format!("eos-action:{id}/good/")));
    let (_, _, share) = rig.fetch(router, &format!("/api/surfaces/sf-paper/issues/{id}/document?mode=share")).await;
    assert!(!share.contains("eos-action:"));
    let (status, _, _) = rig.fetch(router, &format!("/api/surfaces/sf-paper/issues/{id}/document?mode=print")).await;
    assert_eq!(status, 400);
    let (_, _, preview) = rig.fetch(router, &format!("/api/surfaces/sf-paper/issues/{id}/mail")).await;
    assert!(preview.contains("max-width:640px") && preview.contains("data:image/jpeg"));
    let other = rig.module.render().mail_document(&id, "rn-2", false).await.expect_err("another run's issue");
    assert!(matches!(other, eos_core::Error::NotFound { .. }), "{other}");
    let mail = rig.module.render().mail_document(&id, "rn-1", false).await.expect("a mail");
    assert_eq!(mail.subject, "Morning Paper · No. 1");
    assert_eq!(mail.pdf, None);
    assert_eq!(mail.inline_images.len(), 1);
    assert!(mail.html.contains(&format!("cid:{}", mail.inline_images[0].cid)));
    assert!(mail.text.contains("Deterministic replays"));
}

#[tokio::test]
async fn an_issue_prints_to_its_export_file_on_the_paper_asked_with_its_images_inlined() {
    let rig = Rig::new().await;
    paper(&rig, "standing").await;
    let line = tools(&rig).fill_page("w-lead", json_file("sample.json")).await.expect("accepted");
    let id = issue_id(&line);
    settled(&rig, &id).await;
    let path = format!("/api/surfaces/sf-paper/issues/{id}/pdf");
    let (status, answer) = rig.ask(Method::Post, &path, Some(json!({"paper": "letter"}))).await;
    assert_eq!(status, 200, "{answer}");
    let out = rig.dir.path().join("surfaces/sf-paper/exports").join(format!("{id}.pdf"));
    assert_eq!(answer, json!({"path": out.to_string_lossy(), "bytes": eos_testkit::FAKE_PDF.len()}));
    assert_eq!(std::fs::read(&out).expect("written"), eos_testkit::FAKE_PDF);
    let (doc, paper) = rig.printer.printed()[0].clone();
    assert_eq!(paper, eos_core::surface::Paper::Letter);
    let held = doc.url.strip_prefix("http://raw.eos.localhost").expect("a raw page").to_owned();
    let raw = Router::builder().routes(rig.module.raw_routes()).build().expect("raw router");
    let (_, _, printed) = rig.fetch(&raw, &held).await;
    assert!(printed.contains("data:image/jpeg;base64,"), "images are inlined");
    assert_eq!(rig.ask(Method::Post, &path, Some(json!({}))).await.0, 200, "A4 when no paper is named");
    assert_eq!(rig.printer.printed()[1].1, eos_core::surface::Paper::A4);
    assert_eq!(rig.ask(Method::Post, &path, Some(json!({"paper": "a3"}))).await.0, 400);
    let mailed = rig.module.render().mail_document(&id, "rn-1", true).await.expect("a mail");
    assert_eq!(mailed.pdf.as_deref(), Some(out.as_path()), "a mail asked to carry its PDF prints it");
    rig.printer.set_available(false);
    let (status, refused) = rig.ask(Method::Post, &path, Some(json!({}))).await;
    assert_eq!((status, refused["error"].as_str()), (409, Some("A PDF needs Eos's window: open Eos and try again")));
    let without = rig.module.render().mail_document(&id, "rn-1", true).await.expect("a mail without its window");
    assert_eq!(without.pdf, None, "without the window the mail goes without its PDF");
}

#[tokio::test]
async fn plain_reading_answers_a_page_issue_as_its_fallback_view() {
    let rig = Rig::new().await;
    paper(&rig, "standing").await;
    let line = tools(&rig).fill_page("w-lead", json_file("issue-2.json")).await.expect("accepted");
    let id = issue_id(&line);
    let (_, read) = rig.ask(Method::Get, &format!("/api/surfaces/sf-paper/issues/{id}"), None).await;
    assert!(read["body"]["plain"].is_null());
    let on = json!({"textScale": 115, "contrast": "normal", "plain": true});
    assert_eq!(rig.ask(Method::Put, "/api/settings/surfaces", Some(on)).await.0, 200);
    let (_, read) = rig.ask(Method::Get, &format!("/api/surfaces/sf-paper/issues/{id}"), None).await;
    assert_eq!(read["body"]["plain"]["title"], "Morning Paper");
}
