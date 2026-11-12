//! What the TypeScript route tests pin (`manager/modules/genui/__tests__`,
//! `core/src/__tests__/PresentView.test.ts`), against the real store and the
//! real settings files.

mod support;

use std::sync::{Arc, Mutex};

use eos_contracts::{Area, GeocodeResult, Num};
use eos_core::agent::{ToolInputDelta, ToolInputPhase};
use eos_core::genui::PresentRefusal;
use eos_core::shell::{PositionError, PositionFix};
use eos_core::store::{ConfigSource, UserSettingsStore};
use eos_runtime::access::Caller;
use eos_runtime::bus::{Filter, Scope};
use eos_runtime::http::{Method, Request};
use eos_runtime::module::{Module, PromptValue};
use eos_testkit::{FakeGeocoder, FakeLocation, FakeMap, FakeMedia, FakePlaceSearch};
use serde_json::{Value, json};
use support::{Fakes, Harness};

const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

fn board() -> Value {
    json!({ "title": "Two cafes", "data": { "places": [{ "type": "Place", "id": "a", "name": "Bean" }] },
            "ui": "<List of=\"places\"/>", "summary": "Bean." })
}

async fn present(h: &Harness, agent: &str, input: Value) -> support::Answer {
    h.agent(agent, Method::Post, "/api/genui/views", Some(json!({ "input": input }))).await
}

async fn put_genui(h: &Harness, patch: Value) -> support::Answer {
    h.user(Method::Put, "/api/settings/genui", Some(patch)).await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_view_is_stored_for_an_orchestrator_and_a_focused_session_only() {
    let h = Harness::start(Fakes::default()).await;
    for agent in ["o-ORCH", "w-CHAT"] {
        let made = present(&h, agent, board()).await;
        assert_eq!(made.status, 201, "{agent}");
        let id = made.json()["viewId"].as_str().expect("a view id").to_owned();
        let view = h.anyone(Method::Get, &format!("/api/genui/views/{id}"), None).await.json();
        assert_eq!((view["workerId"].as_str(), view["kind"].as_str()), (Some(agent), Some("view")));
        assert_eq!(view["spec"]["title"], "Two cafes");
    }
    for refused in [
        present(&h, "w-KID1", board()).await,
        present(&h, "w-nobody", board()).await,
        h.user(Method::Post, "/api/genui/views", Some(json!({ "input": board() }))).await,
    ] {
        assert_eq!(refused.status, 403);
        assert!(refused.error().starts_with("only an orchestrator or a focused session can present"));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_tools_own_fields_are_stored_and_a_foreign_replaces_warns() {
    let h = Harness::start(Fakes::default()).await;
    let mut input = board();
    input["extra"] = json!("dropped");
    let first = present(&h, "o-ORCH", input).await.json();
    let id = first["viewId"].as_str().expect("id").to_owned();
    let stored = h.anyone(Method::Get, &format!("/api/genui/views/{id}"), None).await.json();
    assert!(stored["spec"].get("extra").is_none());
    assert!(first["warnings"][0]["message"].as_str().is_some_and(|m| m.contains("is not a present field")));

    // Replacing one's own view is silent; another agent's (or an unknown id) warns and still renders.
    let mut own = board();
    own["replaces"] = json!(id);
    assert_eq!(present(&h, "o-ORCH", own.clone()).await.json()["warnings"], json!([]));
    let foreign = present(&h, "w-CHAT", own).await;
    assert_eq!(foreign.status, 201);
    assert_eq!(
        foreign.json()["warnings"],
        json!([{ "path": "replaces", "message": format!("{id} is not one of your views — shown as a new view") }])
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_users_switches_are_enforced_at_call_time() {
    let h = Harness::start(Fakes::default()).await;
    assert_eq!(put_genui(&h, json!({ "apps": false })).await.status, 200);
    let app = json!({ "input": { "title": "Counter", "html": "<button>0</button>", "summary": "Counts." } });
    let refused = h.agent("o-ORCH", Method::Post, "/api/genui/apps", Some(app.clone())).await;
    assert_eq!(
        (refused.status, refused.error().as_str()),
        (403, "Apps are turned off in Settings — use present or plain text")
    );
    assert_eq!(present(&h, "o-ORCH", board()).await.status, 201, "views still render while apps are off");

    assert_eq!(put_genui(&h, json!({ "level": "text", "apps": true })).await.status, 200);
    for refused in
        [present(&h, "o-ORCH", board()).await, h.agent("o-ORCH", Method::Post, "/api/genui/apps", Some(app)).await]
    {
        assert_eq!((refused.status, refused.error().as_str()), (403, "Visual answers are off — answer in text"));
    }
    // The same switch through the tools' port: an answer to take, not an error to retry.
    let tools = h.module.visual_answers();
    assert_eq!(
        tools.present_view("o-ORCH", board()).await,
        Err(PresentRefusal::SwitchedOff("Visual answers are off — answer in text"))
    );
    assert_eq!(tools.present_view("w-KID1", board()).await, Err(PresentRefusal::NotPresenter));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_views_state_is_the_users_to_write() {
    let h = Harness::start(Fakes::default()).await;
    let id = present(&h, "o-ORCH", board()).await.json()["viewId"].as_str().expect("id").to_owned();
    let path = format!("/api/genui/views/{id}/state");

    let heard: Arc<Mutex<Vec<Value>>> = Arc::default();
    let sink = heard.clone();
    let _on = h.runtime.kernel.bus.on(Filter::from("genui:change"), move |event| {
        sink.lock().expect("heard").push(event.payload_as::<Value>().expect("json"));
    });

    let agent = h.agent("o-ORCH", Method::Put, &path, Some(json!({ "state": { "open": true } }))).await;
    assert_eq!((agent.status, agent.error().as_str()), (403, "ui token required"));
    let saved = h.user(Method::Put, &path, Some(json!({ "state": { "open": true } }))).await;
    assert_eq!(saved.status, 200);
    assert_eq!(saved.json()["state"], json!({ "open": true }));
    assert_eq!(*heard.lock().expect("heard"), [json!({ "viewId": id, "state": { "open": true } })]);
    assert_eq!(h.agent("w-KID1", Method::Get, &path, None).await.json()["state"], json!({ "open": true }));

    let big = json!({ "state": { "blob": "x".repeat(33 * 1024) } });
    let too_big = h.user(Method::Put, &path, Some(big)).await;
    assert_eq!(
        (too_big.status, too_big.error().as_str()),
        (400, "invalid request: state: view state is larger than 32 KB")
    );
    let huge = json!({ "state": { "blob": "x".repeat(64 * 1024) } });
    assert_eq!(h.user(Method::Put, &path, Some(huge)).await.status, 413);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_removed_workers_views_go_with_it() {
    let h = Harness::start(Fakes::default()).await;
    let id = present(&h, "o-ORCH", board()).await.json()["viewId"].as_str().expect("id").to_owned();
    let kept = present(&h, "w-CHAT", board()).await.json()["viewId"].as_str().expect("id").to_owned();
    h.runtime.kernel.bus.publish_raw("worker:removed", None, br#"{"workerId":"o-ORCH"}"#.to_vec().into());
    h.runtime.kernel.bus.flush().await;
    // The removal runs on a task the event started: wait for the row to go.
    for _ in 0..200 {
        if h.anyone(Method::Get, &format!("/api/genui/views/{id}"), None).await.status == 404 {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert_eq!(h.anyone(Method::Get, &format!("/api/genui/views/{id}"), None).await.status, 404);
    assert_eq!(h.anyone(Method::Get, &format!("/api/genui/views/{kept}"), None).await.status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_are_written_where_they_live_and_only_by_the_user() {
    let h = Harness::start(Fakes::default()).await;
    let defaults = h.anyone(Method::Get, "/api/settings/genui", None).await.json();
    assert_eq!(defaults, json!({ "level": "balanced", "apps": true, "locationShare": true, "logoDevKey": null }));
    assert_eq!(h.anyone(Method::Put, "/api/settings/genui", Some(json!({ "level": "rich" }))).await.status, 403);

    h.config.patch("compaction", json!({ "threshold": 0.8 }).as_object().expect("object").clone()).expect("written");
    let saved = put_genui(&h, json!({ "level": "rich", "locationShare": true, "logoDevKey": "pk_abc123XYZ" })).await;
    assert_eq!(
        saved.json(),
        json!({ "level": "rich", "apps": true, "locationShare": true, "logoDevKey": "pk_abc123XYZ" })
    );
    assert_eq!(
        serde_json::to_value(h.settings.read()).expect("json"),
        json!({ "genui.level": "rich", "location.share": true })
    );
    let file: Value = serde_json::from_str(&h.temp.home.read("config.json")).expect("json");
    assert_eq!(file["genui"], json!({ "logoDevKey": "pk_abc123XYZ" }));
    assert_eq!(file["compaction"], json!({ "threshold": 0.8 }), "other blocks untouched");
    assert_eq!(put_genui(&h, json!({ "apps": false })).await.json()["apps"], false);

    for clear in [Value::Null, json!("")] {
        put_genui(&h, json!({ "logoDevKey": "pk_abc123XYZ" })).await;
        let cleared = put_genui(&h, json!({ "logoDevKey": clear })).await;
        assert_eq!((cleared.status, &cleared.json()["logoDevKey"]), (200, &Value::Null));
        let file: Value = serde_json::from_str(&h.temp.home.read("config.json")).expect("json");
        assert_eq!(file["genui"], json!({}));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_bad_settings_patch_writes_nothing() {
    let h = Harness::start(Fakes::default()).await;
    for body in
        [json!({ "logoDevKey": "sk_live_123456" }), json!({ "level": "loud" }), json!({ "level": "rich", "typo": 1 })]
    {
        assert_eq!(put_genui(&h, body.clone()).await.status, 400, "{body}");
    }
    assert_eq!(
        put_genui(&h, json!({ "level": "rich", "typo": 1 })).await.error(),
        "invalid request: : Unrecognized key(s) in object: 'typo'"
    );
    assert!(h.settings.read().is_empty());
    assert!(!h.temp.home.join("config.json").exists());

    let protected = h.module.protected_settings().expect("protected keys");
    assert_eq!(protected.keys, ["genui.level", "genui.apps", "location.share"]);
    // What the flat settings route answers (fixtures/wire/recordings/33-settings.json, `settings-protected-key`).
    assert_eq!(
        protected.refusal(["genui.level"]).as_deref(),
        Some("genui.level is set only through /api/settings/genui")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn the_level_reaches_the_prompt() {
    let h = Harness::start(Fakes::default()).await;
    let level = |h: &Harness| h.module.prompt_variables();
    let text = |vars: &[(&'static str, PromptValue)]| match &vars[0] {
        ("GENUI_LEVEL", PromptValue::Text(text)) => text.clone(),
        other => panic!("{other:?}"),
    };
    assert!(text(&level(&h)).starts_with("The user set visual answers to **balanced**"));
    assert_eq!(level(&h)[1], ("GENUI_OFF", PromptValue::Flag(false)));
    put_genui(&h, json!({ "level": "rich" })).await;
    assert!(text(&level(&h)).starts_with("The user set visual answers to **rich**"));
    put_genui(&h, json!({ "level": "text" })).await;
    assert!(text(&level(&h)).starts_with("The user turned visual answers **off**"));
    assert_eq!(level(&h)[1], ("GENUI_OFF", PromptValue::Flag(true)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_followed_tools_input_becomes_genui_delta_frames_for_its_worker() {
    let h = Harness::start(Fakes::default()).await;
    for (tool, followed) in [
        ("mcp__orchestrator__present", true),
        ("mcp__worker__present_app", true),
        ("mcp__orchestrator__presentation", false),
        ("mcp__slides__present", false),
        ("Bash", false),
    ] {
        assert_eq!(h.module.follows_tool_input(tool), followed, "{tool}");
    }
    type Frames = Vec<(Option<Scope>, String)>;
    let heard: Arc<Mutex<Frames>> = Arc::default();
    let sink = heard.clone();
    let _on = h.runtime.kernel.bus.on(Filter::from("genui:delta"), move |event| {
        sink.lock().expect("heard").push((event.scope.clone(), String::from_utf8_lossy(&event.payload).into_owned()));
    });
    let name = "mcp__orchestrator__present";
    for (phase, text) in
        [(ToolInputPhase::Start, ""), (ToolInputPhase::Append, "{\"title\":"), (ToolInputPhase::Stop, "")]
    {
        h.module.on_tool_input_delta("o-ORCH", &ToolInputDelta::new("toolu_1", name, phase, text.to_owned()));
    }
    h.runtime.kernel.bus.flush().await;
    let heard = heard.lock().expect("heard");
    // The payload the dashboard reads: `GenuiDelta`, fields in today's order.
    assert_eq!(
        heard.iter().map(|(_, frame)| frame.as_str()).collect::<Vec<_>>(),
        [
            r#"{"workerId":"o-ORCH","callId":"toolu_1","name":"mcp__orchestrator__present","phase":"start","text":""}"#,
            r#"{"workerId":"o-ORCH","callId":"toolu_1","name":"mcp__orchestrator__present","phase":"append","text":"{\"title\":"}"#,
            r#"{"workerId":"o-ORCH","callId":"toolu_1","name":"mcp__orchestrator__present","phase":"stop","text":""}"#,
        ]
    );
    assert!(heard.iter().all(|(scope, _)| scope.as_ref() == Some(&Scope::worker("o-ORCH"))));
    let typed: eos_contracts::GenuiDelta = serde_json::from_str(&heard[1].1).expect("the contract type");
    assert_eq!(serde_json::to_string(&typed).expect("json"), heard[1].1);
}

fn media_fakes() -> Fakes {
    Fakes {
        media: FakeMedia::default().with("https://cdn.example/a.png", "image/png", PNG, "\"abc\"").with(
            "icon:acme.example",
            "image/svg+xml",
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
            "\"svg\"",
        ),
        map: FakeMap::default()
            .with("style", "application/json", b"{}")
            .with("planet/v1/1/0/0.pbf", "application/x-protobuf", b"tile")
            .with("weird", "text/html", b"<script>alert(1)</script>"),
        ..Fakes::default()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn media_and_map_are_the_dashboards_alone_and_never_a_page() {
    let h = Harness::start(media_fakes()).await;
    let targets = [
        "/api/genui/media/img?src=https%3A%2F%2Fcdn.example%2Fa.png",
        "/api/genui/media/og?url=https%3A%2F%2Fexample.com%2F",
        "/api/genui/media/icon?site=acme.example",
        "/api/genui/map/style.json",
        "/api/genui/map/t/planet/v1/1/0/0.pbf",
    ];
    for target in targets {
        let stranger = h.anyone(Method::Get, target, None).await;
        assert_eq!((stranger.status, stranger.error().as_str()), (403, "ui token required"), "{target}");
        // A frame or window navigated to the proxy is refused even with the token.
        for dest in ["document", "iframe", "IFRAME", "embed"] {
            let nav = Request::new(Method::Get, target, Caller::DASHBOARD).header("sec-fetch-dest", dest);
            let nav = h.send(nav).await;
            assert_eq!((nav.status, nav.error().as_str()), (403, "not a page"), "{target} {dest}");
        }
    }
    assert!(h.media.asked.lock().expect("asked").is_empty(), "refused before any fetch");
    let image = Request::new(Method::Get, targets[0], Caller::DASHBOARD).header("sec-fetch-dest", "image");
    assert_eq!(h.send(image).await.status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn images_are_served_inert_cacheable_and_revalidatable() {
    let h = Harness::start(media_fakes()).await;
    let target = "/api/genui/media/img?src=https%3A%2F%2Fcdn.example%2Fa.png";
    let image = h.user(Method::Get, target, None).await;
    assert_eq!((image.status, image.bytes.as_slice()), (200, PNG));
    assert_eq!(image.header("content-type"), Some("image/png"));
    assert_eq!(image.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(image.header("cache-control"), Some("private, max-age=604800"));
    assert_eq!(image.header("etag"), Some("\"abc\""));
    assert!(image.header("content-security-policy").is_some_and(|csp| csp.contains("sandbox")));
    assert_eq!(*h.media.asked.lock().expect("asked"), ["https://cdn.example/a.png"]);

    let again = Request::new(Method::Get, target, Caller::DASHBOARD).header("if-none-match", "\"abc\"");
    let again = h.send(again).await;
    assert_eq!((again.status, again.bytes.len(), again.header("etag")), (304, 0, Some("\"abc\"")));

    let miss = h.user(Method::Get, "/api/genui/media/img?src=https://cdn.example/missing.png", None).await;
    assert_eq!((miss.status, miss.error().as_str()), (404, "no image"));
    assert_eq!(miss.header("cache-control"), Some("private, max-age=3600"));
    assert_eq!(h.user(Method::Get, "/api/genui/media/img?src=not-a-url", None).await.status, 400);
    assert_eq!(h.user(Method::Get, "/api/genui/media/icon", None).await.status, 400);
    let svg = h.user(Method::Get, "/api/genui/media/icon?site=acme.example", None).await;
    assert_eq!(svg.header("content-type"), Some("image/svg+xml"));
}

#[tokio::test(flavor = "multi_thread")]
async fn map_resources_are_proxied_and_never_served_as_an_active_type() {
    let h = Harness::start(media_fakes()).await;
    let tile = h.user(Method::Get, "/api/genui/map/t/planet/v1/1/0/0.pbf", None).await;
    assert_eq!((tile.status, tile.header("content-type")), (200, Some("application/x-protobuf")));
    let odd = h.user(Method::Get, "/api/genui/map/t/weird", None).await;
    assert_eq!(odd.header("content-type"), Some("application/octet-stream"));
    assert_eq!(odd.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(h.user(Method::Get, "/api/genui/map/style.json", None).await.status, 200);
    let gone = h.user(Method::Get, "/api/genui/map/t/nope", None).await;
    assert_eq!((gone.status, gone.header("cache-control")), (404, Some("private, max-age=300")));
    assert_eq!(*h.map.asked.lock().expect("asked"), ["planet/v1/1/0/0.pbf", "weird", "style", "nope"]);
}

fn moda() -> GeocodeResult {
    GeocodeResult { lat: Num(40.99), lon: Num(29.03), label: "Moda, İstanbul".to_owned(), area: None, kind: None }
}

#[tokio::test(flavor = "multi_thread")]
async fn geocoding_and_place_search_answer_without_the_token() {
    let geocoder = FakeGeocoder::default();
    geocoder.places.lock().expect("places").insert("Moda".to_owned(), vec![moda()]);
    let places = FakePlaceSearch::default();
    places.places.lock().expect("places").push(json!({ "id": "osm:node/1", "type": "Place", "name": "Bean" }));
    let h = Harness::start(Fakes { geocoder, places, ..Fakes::default() }).await;

    let found = h.anyone(Method::Get, "/api/genui/geocode?q=Moda&limit=2", None).await;
    assert_eq!(found.status, 200);
    assert_eq!(
        found.json(),
        json!({ "results": [{ "lat": 40.99, "lon": 29.03, "label": "Moda, İstanbul" }],
                "attribution": "© OpenStreetMap contributors (ODbL)" })
    );
    assert_eq!(*h.geocoder.searched.lock().expect("searched"), [("Moda".to_owned(), 2)]);

    let by_point = h
        .anyone(
            Method::Post,
            "/api/genui/places",
            Some(json!({ "category": "cafe", "near": { "lat": 41, "lon": 29 } })),
        )
        .await;
    assert_eq!(by_point.status, 200);
    assert_eq!(by_point.json()["center"], json!({ "lat": 41.0, "lon": 29.0 }));
    assert_eq!(by_point.json()["radiusM"], 1500);
    {
        let asked = h.places.asked.lock().expect("asked");
        let q = asked.last().expect("asked");
        assert_eq!((q.query.as_deref(), q.category.as_deref()), (None, Some("cafe")));
        assert_eq!((q.lat, q.lon, q.radius_m, q.limit), (41.0, 29.0, 1500.0, 12));
    }

    let by_name = json!({ "query": "ramen", "near": { "text": "Moda" }, "radiusM": 800, "limit": 5 });
    let by_name = h.anyone(Method::Post, "/api/genui/places", Some(by_name)).await;
    assert_eq!(by_name.status, 200);
    assert_eq!(by_name.json()["center"], json!({ "lat": 40.99, "lon": 29.03, "label": "Moda, İstanbul" }));
    assert_eq!(by_name.json()["places"][0]["name"], "Bean");

    let lost =
        h.anyone(Method::Post, "/api/genui/places", Some(json!({ "query": "x", "near": { "text": "nowhere" } })));
    let lost = lost.await;
    assert_eq!(lost.status, 404);
    assert_eq!(lost.error(), "Couldn't find \"nowhere\" on the map — try a fuller name (street, district, city).");
    let nothing = h.anyone(Method::Post, "/api/genui/places", Some(json!({ "near": { "lat": 1, "lon": 1 } }))).await;
    assert_eq!(nothing.status, 400);

    *h.geocoder.fail.lock().expect("fail") = Some("OpenStreetMap geocoding answered 503".to_owned());
    let down = h.anyone(Method::Get, "/api/genui/geocode?q=down", None).await;
    assert_eq!((down.status, down.error().as_str()), (502, "OpenStreetMap geocoding answered 503"));
}

const FIX: PositionFix = PositionFix { lat: 40.9876, lon: 29.0321, accuracy: 35.0, at: 1_760_000_000_000 };

fn kadikoy() -> Area {
    Area { district: Some("Kadıköy".into()), city: Some("İstanbul".into()), country: Some("Türkiye".into()) }
}

async fn located(location: Option<FakeLocation>) -> Harness {
    let geocoder = FakeGeocoder::default();
    *geocoder.area.lock().expect("area") = Some(kadikoy());
    let location = location.map(|l| Arc::new(l) as Arc<dyn eos_core::shell::Location>);
    Harness::start(Fakes { geocoder, location, ..Fakes::default() }).await
}

#[tokio::test(flavor = "multi_thread")]
async fn the_position_is_for_the_dashboard_an_orchestrator_or_a_focused_session() {
    let h = located(Some(FakeLocation::at(FIX))).await;
    for agent in ["o-ORCH", "w-CHAT"] {
        assert_eq!(h.agent(agent, Method::Get, "/api/location", None).await.status, 200, "{agent}");
    }
    for refused in [
        h.agent("w-KID1", Method::Get, "/api/location", None).await,
        h.agent("w-nobody", Method::Get, "/api/location", None).await,
        h.anyone(Method::Get, "/api/location", None).await,
    ] {
        assert_eq!(refused.status, 403);
        assert_eq!(
            refused.json(),
            json!({ "error": "location is only for the Eos app, an orchestrator or a focused session", "code": "forbidden" })
        );
        assert_eq!(refused.header("cache-control"), Some("no-store"));
    }
    // Where this computer is never crosses to another one.
    let peer = Caller::Peer { device: "ab".repeat(32).into(), human: true };
    let crossed = h.send(Request::new(Method::Get, "/api/location", peer)).await;
    assert_eq!((crossed.status, crossed.error().as_str()), (403, "not available from another device"));

    let here = h.user(Method::Get, "/api/location", None).await;
    assert_eq!(here.status, 200);
    assert_eq!(
        here.json(),
        json!({ "lat": 40.9876, "lon": 29.0321, "accuracy": 35, "at": 1_760_000_000_000_i64,
                "area": { "district": "Kadıköy", "city": "İstanbul", "country": "Türkiye" } })
    );
    assert_eq!(here.header("cache-control"), Some("no-store"));
    assert_eq!(h.geocoder.reversed.lock().expect("reversed").last(), Some(&(40.9876, 29.0321)));
    // The same through the tools' port.
    let tools = h.module.user_location();
    assert_eq!(tools.current_for("o-ORCH").await.expect("a position").area, Some(kadikoy()));
    assert_eq!(tools.current_for("w-KID1").await.expect_err("refused").code, "forbidden");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_position_is_refused_with_a_sentence_that_says_what_to_do() {
    // Sharing off: the system is never asked.
    let location = Arc::new(FakeLocation::at(FIX));
    let geocoder = FakeGeocoder::default();
    let h = Harness::start(Fakes { geocoder, location: Some(location.clone()), ..Fakes::default() }).await;
    put_genui(&h, json!({ "locationShare": false })).await;
    let off = h.user(Method::Get, "/api/location", None).await;
    assert_eq!((off.status, off.json()["code"].as_str()), (403, Some("sharing-off")));
    assert!(off.error().contains("Settings › General › Visual answers"));
    assert_eq!(*location.asked.lock().expect("asked"), 0);

    // No shell to ask.
    let headless = located(None).await;
    let offline = headless.user(Method::Get, "/api/location", None).await;
    assert_eq!((offline.status, offline.json()["code"].as_str()), (503, Some("app-offline")));

    for (error, status, code) in [
        (PositionError::Denied, 403, "denied"),
        (PositionError::Disabled, 403, "disabled"),
        (PositionError::Timeout, 504, "timeout"),
        (PositionError::Unavailable, 503, "unavailable"),
        (PositionError::Unsupported, 503, "unsupported"),
    ] {
        let h = located(Some(FakeLocation::failing(error))).await;
        let refused = h.user(Method::Get, "/api/location", None).await;
        assert_eq!((refused.status, refused.json()["code"].as_str()), (status, Some(code)), "{error:?}");
    }
    let nowhere = PositionFix { lat: f64::NAN, ..FIX };
    let bad = located(Some(FakeLocation::at(nowhere))).await.user(Method::Get, "/api/location", None).await;
    assert_eq!(bad.json()["code"], "unsupported");
    assert_eq!(bad.error(), "This version of the Eos app can't read the location. (the app sent no coordinates)");

    // The area is a courtesy: the position is answered without it.
    let h = located(Some(FakeLocation::at(FIX))).await;
    *h.geocoder.fail.lock().expect("fail") = Some("offline".to_owned());
    let bare = h.user(Method::Get, "/api/location", None).await;
    assert_eq!(bare.status, 200);
    assert!(bare.json().get("area").is_none());
}
