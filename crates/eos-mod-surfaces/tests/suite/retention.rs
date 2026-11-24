//! What a surface keeps (D32) once a run gives it an issue, and how it
//! leaves with its routine for good.

use eos_core::store::StoredIssue;
use eos_core::surface::{ReturnedView, SurfaceAuthoring};
use eos_runtime::http::Method;
use eos_surface::{IssueKind, Level, Place, VersionStatus};
use serde_json::json;

use crate::rig::{Rig, issue, surface, version};

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn view() -> ReturnedView {
    ReturnedView {
        place: "result".into(),
        view: json!({"title": "Overnight", "summary": "Three mails came in.", "ui": "<Text>Three mails</Text>"}),
        bindings: None,
    }
}

async fn issue_ids(rig: &Rig) -> Vec<String> {
    let found = rig.temp.port().read(|tx| tx.surface_issues().of_surface("sf-mail", None, 1000)).await;
    found.expect("reads").into_iter().map(|i| i.id).collect()
}

#[tokio::test]
async fn a_surface_keeps_its_newest_hundred_issues_what_was_kept_and_the_versions_they_use() {
    let rig = Rig::new().await;
    rig.run_worker("rt-1", "Morning mail", "rn-new", "standing", "w-lead");
    rig.clock.advance(30 * DAY_MS);
    rig.temp.exec(&format!("UPDATE routines SET started_at = {}", 2 * DAY_MS));
    let mut issues: Vec<StoredIssue> = (0..101)
        .map(|n| StoredIssue {
            id: format!("si-{n:03}"),
            created_at: 3 * DAY_MS + n,
            kept: n == 0,
            version: (n == 1).then_some(1),
            run_id: None,
            ..issue(&format!("si-{n:03}"), "sf-mail")
        })
        .collect();
    issues.push(StoredIssue {
        id: "si-trial".into(),
        trial: true,
        seq: None,
        created_at: DAY_MS,
        ..issue("si-trial", "sf-mail")
    });
    let versions = (1..=36)
        .map(|n| version("sf-mail", n, if n == 36 { VersionStatus::Kept } else { VersionStatus::Superseded }))
        .collect();
    let mut mail = surface("sf-mail", "rt-1", Level::View, Place::NeedsYou, 1);
    mail.current_version = Some(36);
    rig.seed(vec![mail], versions, issues).await;

    rig.module.tools().return_view("w-lead", view()).await.expect("returned");

    let left = issue_ids(&rig).await;
    assert_eq!(left.len(), 101, "the newest hundred and the one kept");
    assert!(left.contains(&"si-000".to_owned()), "kept by the user");
    for gone in ["si-001", "si-trial"] {
        assert!(!left.contains(&gone.to_owned()), "{gone}");
    }
    let (_, list) = rig.ask(Method::Get, "/api/surfaces/sf-mail/versions", None).await;
    let numbers: Vec<i64> =
        list["versions"].as_array().expect("versions").iter().filter_map(|v| v["version"].as_i64()).collect();
    assert_eq!(numbers.len(), 31, "the kept one and the newest thirty others");
    assert!(!numbers.contains(&1) && !numbers.contains(&5) && numbers.contains(&6) && numbers.contains(&36));
    assert_eq!(rig.images.collected().last().map(|(id, _)| id.clone()), Some("sf-mail".into()));
}

#[tokio::test]
async fn a_routine_leaving_for_good_takes_its_surfaces_folders_to_the_trash_and_their_rows() {
    let rig = Rig::new().await;
    let mut page = surface("sf-page", "rt-1", Level::Page, Place::RoutinePage, 1);
    page.current_version = Some(1);
    let kept = StoredIssue { kind: IssueKind::Page, version: Some(1), ..issue("si-1", "sf-page") };
    rig.seed(
        vec![page, surface("sf-other", "rt-2", Level::View, Place::NeedsYou, 1)],
        vec![version("sf-page", 1, VersionStatus::Kept)],
        vec![kept],
    )
    .await;
    rig.ask(Method::Put, "/api/surfaces/pins", Some(json!({"surfaceIds": ["sf-page", "sf-other"]}))).await;
    let folder = rig.dir.path().join("surfaces/sf-page/img");
    std::fs::create_dir_all(&folder).expect("a folder");
    std::fs::write(folder.join("a.jpg"), b"JPEG").expect("an image");

    rig.author().remove_for_routine("rt-1").await.expect("removed");

    assert_eq!(rig.trash.trashed(), vec![rig.dir.path().join("surfaces/sf-page")]);
    assert_eq!(rig.ask(Method::Get, "/api/surfaces/sf-page", None).await.0, 404);
    let left = rig.temp.port().read(|tx| tx.surface_issues().find("si-1")).await.expect("reads");
    assert!(left.is_none());
    assert_eq!(rig.ask(Method::Get, "/api/surfaces/pins", None).await.1, json!({"surfaceIds": ["sf-other"]}));
    assert_eq!(rig.ask(Method::Get, "/api/surfaces/sf-other", None).await.0, 200, "another routine's surface stays");
}
