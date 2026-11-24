//! Home's pins: at most three, each surface once, announced after commit, an
//! archived surface unpinned; and each pin as its tile reads.

use eos_core::store::StoredIssue;
use eos_core::surface::SurfaceAuthoring;
use eos_mod_surfaces::SurfaceAuthor;
use eos_runtime::http::Method;
use eos_surface::{IssueKind, Level, Place, VersionStatus};
use serde_json::json;

use crate::rig::{Rig, issue, surface, version};

async fn four(rig: &Rig) {
    let surfaces = ["sf-a", "sf-b", "sf-c", "sf-d"]
        .iter()
        .enumerate()
        .map(|(n, id)| surface(id, &format!("rt-{n}"), Level::View, Place::NeedsYou, 1))
        .collect();
    rig.seed(surfaces, vec![], vec![]).await;
}

fn pins_announced(rig: &Rig) -> usize {
    rig.temp.announced.list().iter().filter(|(topic, _)| *topic == "surfaces:pins").count()
}

#[tokio::test]
async fn home_holds_three_pins_and_a_fourth_asks_to_replace_one() {
    let rig = Rig::new().await;
    four(&rig).await;
    let (status, pins) =
        rig.ask(Method::Put, "/api/surfaces/pins", Some(json!({"surfaceIds": ["sf-b", "sf-a", "sf-b"]}))).await;
    assert_eq!((status, pins), (200, json!({"surfaceIds": ["sf-b", "sf-a"]})), "each surface once, in order");
    assert_eq!(pins_announced(&rig), 1);
    let (status, _) =
        rig.ask(Method::Put, "/api/surfaces/pins", Some(json!({"surfaceIds": ["sf-a", "sf-b", "sf-c", "sf-d"]}))).await;
    assert_eq!(status, 409, "a fourth pin");
    let (status, _) =
        rig.ask(Method::Put, "/api/surfaces/pins", Some(json!({"surfaceIds": ["sf-a", "sf-gone"]}))).await;
    assert_eq!(status, 404);
    let (_, pins) = rig.ask(Method::Get, "/api/surfaces/pins", None).await;
    assert_eq!(pins, json!({"surfaceIds": ["sf-b", "sf-a"]}), "a refused change leaves the pins");
    rig.ask(Method::Put, "/api/surfaces/pins", Some(json!({"surfaceIds": ["sf-b", "sf-a"]}))).await;
    assert_eq!(pins_announced(&rig), 1, "the same pins announce nothing");
}

#[tokio::test]
async fn an_archived_surface_loses_its_pin_and_cannot_be_pinned() {
    let rig = Rig::new().await;
    four(&rig).await;
    rig.ask(Method::Put, "/api/surfaces/pins", Some(json!({"surfaceIds": ["sf-a", "sf-b"]}))).await;
    let author =
        SurfaceAuthor::new(rig.temp.port(), rig.clock.clone(), std::sync::Arc::new(eos_testkit::SeqIds::new()));
    author.archive_for_routine("rt-0").await.expect("archived");
    let (_, pins) = rig.ask(Method::Get, "/api/surfaces/pins", None).await;
    assert_eq!(pins, json!({"surfaceIds": ["sf-b"]}));
    assert_eq!(pins_announced(&rig), 2);
    let (status, _) = rig.ask(Method::Put, "/api/surfaces/pins", Some(json!({"surfaceIds": ["sf-a"]}))).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_tile_reads_its_pages_tile_its_views_summary_or_its_title() {
    let rig = Rig::new().await;
    let mut page = surface("sf-page", "rt-1", Level::Page, Place::RoutinePage, 1);
    page.title = "Desk".into();
    page.current_version = Some(1);
    let mut design = version("sf-page", 1, VersionStatus::Kept);
    design.body_json = json!({
        "template": "<section part=\"desk\"><h1>{title}</h1></section>",
        "style": "",
        "contract": {"type": "object", "fields": {"title": {"type": "text", "max": 40}, "count": {"type": "int"}}},
        "tile": {"headline": "{title}", "detail": "{count} open"},
        "sample": {"title": "Desk", "count": 1},
    })
    .to_string();
    let filled = StoredIssue {
        version: Some(1),
        kind: IssueKind::Page,
        body_json: json!({"data": {"title": "Three reviews wait", "count": 3}}).to_string(),
        created_at: 300,
        ..issue("si-page", "sf-page")
    };
    let view = StoredIssue {
        body_json: json!({"view": {"title": "Overnight", "summary": "Two mails\nand more"}}).to_string(),
        ..issue("si-view", "sf-view")
    };
    rig.seed(
        vec![
            page,
            surface("sf-view", "rt-2", Level::View, Place::NeedsYou, 1),
            surface("sf-bare", "rt-3", Level::View, Place::NeedsYou, 1),
        ],
        vec![design],
        vec![filled, view],
    )
    .await;
    rig.ask(Method::Put, "/api/surfaces/pins", Some(json!({"surfaceIds": ["sf-page", "sf-view", "sf-bare"]}))).await;
    let (status, tiles) = rig.ask(Method::Get, "/api/surfaces/tiles", None).await;
    assert_eq!(status, 200, "{tiles}");
    let tiles = tiles["tiles"].as_array().expect("tiles").clone();
    assert_eq!(
        (
            tiles[0]["slot"].clone(),
            tiles[0]["headline"].clone(),
            tiles[0]["detail"].clone(),
            tiles[0]["issuedAt"].clone()
        ),
        (json!(1), json!("Three reviews wait"), json!("3 open"), json!(300))
    );
    assert_eq!((tiles[1]["headline"].clone(), tiles[1]["detail"].clone()), (json!("Overnight"), json!("Two mails")));
    assert_eq!(tiles[2]["title"], "Overnight mail");
    assert!(tiles[2].get("headline").is_none() && tiles[2].get("issueId").is_none(), "the default tile");
}
