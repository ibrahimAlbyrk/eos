//! Surfaces listed by routine and place, one surface, its versions newest
//! first and one version with its body; the reading settings.

use eos_runtime::access::Caller;
use eos_runtime::http::Method;
use eos_surface::{Level, Place, VersionStatus};
use serde_json::json;

use crate::rig::{Rig, surface, version};

#[tokio::test]
async fn surfaces_list_by_routine_and_place_and_read_one_by_one() {
    let rig = Rig::new().await;
    let mut archived = surface("sf-c", "rt-1", Level::View, Place::NeedsYou, 3);
    archived.archived_at = Some(4);
    let mut page = surface("sf-b", "rt-1", Level::Page, Place::RoutinePage, 2);
    page.current_version = Some(1);
    page.candidate_version = Some(2);
    rig.seed(
        vec![
            surface("sf-a", "rt-1", Level::View, Place::NeedsYou, 1),
            page,
            archived,
            surface("sf-d", "rt-2", Level::View, Place::NeedsYou, 5),
        ],
        vec![version("sf-b", 1, VersionStatus::Kept), version("sf-b", 2, VersionStatus::Candidate)],
        vec![],
    )
    .await;

    let (status, body) = rig.ask(Method::Get, "/api/surfaces?routine=rt-1", None).await;
    assert_eq!(status, 200);
    let ids: Vec<_> = body["surfaces"].as_array().expect("a list").iter().map(|s| s["id"].clone()).collect();
    assert_eq!(ids, [json!("sf-a"), json!("sf-b")], "archived ones are left out");
    let (_, body) = rig.ask(Method::Get, "/api/surfaces?place=needs_you", None).await;
    assert_eq!(body["surfaces"].as_array().map(Vec::len), Some(2));
    let (status, _) = rig.ask(Method::Get, "/api/surfaces?place=attic", None).await;
    assert_eq!(status, 400);

    let (status, one) = rig.ask(Method::Get, "/api/surfaces/sf-b", None).await;
    assert_eq!(status, 200);
    assert_eq!(
        one,
        json!({"id": "sf-b", "routineId": "rt-1", "level": "page", "place": "routine_page", "role": "result",
               "title": "Overnight mail", "currentVersion": 1, "candidateVersion": 2, "createdAt": 2, "updatedAt": 2})
    );
    let (status, _) = rig.ask(Method::Get, "/api/surfaces/sf-zz", None).await;
    assert_eq!(status, 404);

    let (_, versions) = rig.ask(Method::Get, "/api/surfaces/sf-b/versions", None).await;
    let listed: Vec<_> = versions["versions"]
        .as_array()
        .expect("versions")
        .iter()
        .map(|v| (v["version"].clone(), v["status"].clone()))
        .collect();
    assert_eq!(listed, [(json!(2), json!("candidate")), (json!(1), json!("kept"))]);
    assert!(versions["versions"][0].get("body").is_none(), "the list carries no bodies");

    let (status, one) = rig.ask(Method::Get, "/api/surfaces/sf-b/versions/1", None).await;
    assert_eq!(status, 200);
    assert_eq!(one["meta"]["keptAt"], 11);
    assert_eq!(one["body"]["template"], "<p part=\"a\">{title}</p>");
    assert_eq!(one["checks"], json!({"passed": true}));
    for missing in ["/api/surfaces/sf-b/versions/9", "/api/surfaces/sf-b/versions/x"] {
        assert_eq!(rig.ask(Method::Get, missing, None).await.0, 404, "{missing}");
    }

    let phone = Caller::Phone { grant: eos_runtime::access::Tier::Read, mutate: false };
    assert_eq!(rig.ask_as(phone, Method::Get, "/api/surfaces/sf-a", None).await.0, 200, "the phone reads them");
}

#[tokio::test]
async fn reading_settings_default_then_keep_what_the_user_set() {
    let rig = Rig::new().await;
    let (status, body) = rig.ask(Method::Get, "/api/settings/surfaces", None).await;
    assert_eq!((status, body), (200, json!({"textScale": 100, "contrast": "normal", "plain": false})));
    let wanted = json!({"textScale": 130, "contrast": "more", "plain": true});
    let (status, body) = rig.ask(Method::Put, "/api/settings/surfaces", Some(wanted.clone())).await;
    assert_eq!((status, body), (200, wanted.clone()));
    assert_eq!(rig.ask(Method::Get, "/api/settings/surfaces", None).await.1, wanted);
    let (status, _) = rig
        .ask(Method::Put, "/api/settings/surfaces", Some(json!({"textScale": 90, "contrast": "more", "plain": true})))
        .await;
    assert_eq!(status, 400);
    assert_eq!(rig.settings.0.lock().expect("settings").len(), 3, "three keys of its own");
    assert_eq!(rig.ask_as(Caller::Internal, Method::Put, "/api/settings/surfaces", Some(wanted)).await.0, 200);
}
