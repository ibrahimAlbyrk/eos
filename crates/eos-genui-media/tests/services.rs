//! The adapters end to end against a local server: what is asked of each
//! service, what comes back, what is cached. The
//! requests and answers are checked against the TypeScript's
//! (`fixtures/genui-media/vectors.json`).

mod support;

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use eos_core::net::{Geocoder, MapTiles, MediaFetcher, PlaceQuery, PlaceSearch};
use eos_genui_media::{Endpoints, Options, Services, build};
use eos_kit_net::{Resolver, SafeFetcher, is_blocked_ip};
use eos_testkit::{FakeClock, TempHome};
use serde_json::{Value, json};
use support::{Reply, Seen, Server};

const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
const REAL_MAP: &str = "https://tiles.openfreemap.org";

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/genui-media/vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("the vectors file")).expect("json")
}

struct SystemDns;

impl Resolver for SystemDns {
    fn resolve<'a>(
        &'a self,
        _host: &'a str,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<IpAddr>>> + Send + 'a>> {
        Box::pin(async { Ok(vec![IpAddr::V4(Ipv4Addr::LOCALHOST)]) })
    }
}

struct Rig {
    services: Services,
    clock: Arc<FakeClock>,
    sleeps: Arc<Mutex<Vec<u64>>>,
    home: TempHome,
}

/// The adapters pointed at `server`. The test server lives on loopback, so
/// the address guard is told 127.0.0.1 is "public"; every other private
/// address stays refused. A pause is recorded and moves the clock instead of
/// waiting.
fn rig(server: &Server) -> Rig {
    rig_in(TempHome::new(), server)
}

fn rig_in(home: TempHome, server: &Server) -> Rig {
    let clock = Arc::new(FakeClock::new());
    let sleeps: Arc<Mutex<Vec<u64>>> = Arc::default();
    let (ticking, slept) = (clock.clone(), sleeps.clone());
    let allow_loopback = |address: IpAddr| address != IpAddr::V4(Ipv4Addr::LOCALHOST) && is_blocked_ip(address);
    let options = Options {
        endpoints: Endpoints {
            map_origin: server.origin(),
            nominatim: server.origin(),
            overpass: format!("{}/api/interpreter", server.origin()),
        },
        fetcher: SafeFetcher::with(Arc::new(SystemDns), allow_loopback).expect("a fetcher"),
        sleep: Arc::new(move |pause: Duration| {
            let ms = u64::try_from(pause.as_millis()).expect("a short pause");
            slept.lock().expect("sleeps").push(ms);
            ticking.advance(i64::try_from(ms).expect("a short pause"));
            Box::pin(std::future::ready(()))
        }),
    };
    let services = build(&home.join("media-cache"), clock.clone(), options).expect("the adapters");
    Rig { services, clock, sleeps, home }
}

// ---- the map ----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn the_style_is_served_rewritten_with_attribution_and_kept_for_an_hour() {
    let served = vectors()["styleServed"].clone();
    let upstream = served["upstream"].as_str().expect("the style").to_owned();
    let origin_of = Arc::new(Mutex::new(String::new()));
    let origin = origin_of.clone();
    let server = Server::start(move |seen: &Seen| match seen.target.as_str() {
        // The style as OpenFreeMap sends it, its URLs naming this server.
        "/styles/dark" => {
            let body = upstream.replace(REAL_MAP, &origin.lock().expect("origin"));
            Reply::new(200, "application/json; charset=utf-8", body)
        }
        _ => Reply::new(404, "text/plain", ""),
    })
    .await;
    *origin_of.lock().expect("origin") = server.origin();
    let rig = rig(&server);

    let style = rig.services.map.style().await;
    assert_eq!(style.status, 200);
    assert_eq!(Some(style.content_type.as_str()), served["contentType"].as_str());
    assert_eq!(Some(style.cache_control), served["cacheControl"].as_str());
    // Byte for byte what the TypeScript proxy serves (the one string that is
    // the bare origin, which is not rewritten, names this server here).
    let body = String::from_utf8_lossy(&style.body).replace(&server.origin(), REAL_MAP);
    assert_eq!(Some(body.as_str()), served["body"].as_str());
    assert!(server.seen()[0].header("user-agent").is_some_and(|agent| agent.starts_with("eos/")));

    rig.services.map.style().await;
    assert_eq!(server.targets().len(), 1, "kept for an hour");
    rig.clock.advance(60 * 60 * 1000 + 1);
    rig.services.map.style().await;
    assert_eq!(server.targets(), ["/styles/dark", "/styles/dark"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn tilejson_is_rewritten_tiles_pass_untouched_and_nothing_is_fetched_ahead() {
    let tile: &[u8] = &[0x1a, 0x02, 0x00, 0x01];
    let origin_of = Arc::new(Mutex::new(String::new()));
    let origin = origin_of.clone();
    let server = Server::start(move |seen: &Seen| match seen.target.as_str() {
        "/planet" => {
            let origin = origin.lock().expect("origin").clone();
            Reply::json(&json!({ "tiles": [format!("{origin}/planet/v1/{{z}}/{{x}}/{{y}}.pbf")] }))
        }
        "/planet/v1/1/0/0.pbf" => Reply::new(200, "application/x-protobuf", tile),
        "/fonts/Noto%20Sans%20Regular/0-255.pbf" => Reply::new(200, "application/x-protobuf", b"glyphs".to_vec()),
        _ => Reply::new(404, "text/plain", ""),
    })
    .await;
    *origin_of.lock().expect("origin") = server.origin();
    let rig = rig(&server);

    let tilejson: Value = serde_json::from_slice(&rig.services.map.get("planet").await.body).expect("json");
    assert_eq!(tilejson["tiles"], json!(["/api/genui/map/t/planet/v1/{z}/{x}/{y}.pbf"]));
    let got = rig.services.map.get("planet/v1/1/0/0.pbf").await;
    assert_eq!((got.status, got.content_type.as_str(), &got.body[..]), (200, "application/x-protobuf", tile));
    assert_eq!(got.cache_control, "private, max-age=604800");
    assert_eq!(rig.services.map.get("fonts/Noto Sans Regular/0-255.pbf").await.status, 200);
    // Only what was asked for was fetched: the TileJSON names tiles, none was fetched ahead.
    assert_eq!(server.targets(), ["/planet", "/planet/v1/1/0/0.pbf", "/fonts/Noto%20Sans%20Regular/0-255.pbf"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_redirect_off_the_map_is_never_followed_and_failures_are_reported() {
    let elsewhere = Server::start(|_: &Seen| Reply::new(200, "application/x-protobuf", b"not ours".to_vec())).await;
    let away = format!("{}/x.pbf", elsewhere.origin());
    let server = Server::start(move |seen: &Seen| match seen.target.as_str() {
        "/planet/x.pbf" => Reply::redirect(&away),
        "/planet/moved.pbf" => Reply::redirect("/planet/here.pbf"),
        "/planet/here.pbf" => Reply::new(200, "application/x-protobuf", b"tile".to_vec()),
        "/planet/loop.pbf" => Reply::redirect("/planet/loop.pbf"),
        "/planet/err.pbf" => Reply::new(500, "text/plain", ""),
        "/planet/empty.pbf" => Reply::new(204, "text/plain", ""),
        "/planet/broken.json" => Reply::new(200, "application/json", b"{nope".to_vec()),
        _ => Reply::new(404, "text/plain", ""),
    })
    .await;
    let rig = rig(&server);
    let map = &rig.services.map;
    let error =
        |res: &eos_core::net::MapResponse| serde_json::from_slice::<Value>(&res.body).expect("json")["error"].clone();

    let off = map.get("planet/x.pbf").await;
    assert_eq!((off.status, off.cache_control), (502, "no-store"));
    assert_eq!(error(&off), format!("redirect to {}", elsewhere.origin()));
    assert!(elsewhere.seen().is_empty(), "the other host was never contacted");

    assert_eq!(map.get("planet/moved.pbf").await.status, 200, "a redirect inside the map is followed");
    let looping = map.get("planet/loop.pbf").await;
    assert_eq!((looping.status, error(&looping)), (502, json!(format!("redirect to {}", server.origin()))));
    assert_eq!(server.targets().iter().filter(|t| *t == "/planet/loop.pbf").count(), 4, "three hops, then no more");

    let failed = map.get("planet/err.pbf").await;
    assert_eq!((failed.status, error(&failed)), (502, json!("OpenFreeMap answered 500")));
    assert_eq!(error(&map.get("planet/broken.json").await), "OpenFreeMap sent invalid JSON");
    for path in ["planet/none.pbf", "planet/empty.pbf"] {
        let gone = map.get(path).await;
        assert_eq!(
            (gone.status, gone.cache_control, error(&gone)),
            (404, "private, max-age=300", json!("no such map resource"))
        );
    }
    let before = server.targets().len();
    let outside = map.get("../secret").await;
    assert_eq!((outside.status, error(&outside)), (404, json!("not an OpenFreeMap path")));
    assert_eq!(server.targets().len(), before, "a path that leaves the map is refused before any request");
}

// ---- geocoding --------------------------------------------------------------

fn search_rows() -> Value {
    json!([
        { "lat": "40.9903", "lon": "29.0290", "display_name": "Moda, Kadıköy, İstanbul, Türkiye", "type": "suburb",
          "address": { "suburb": "Moda", "city_district": "Kadıköy", "city": "İstanbul", "country": "Türkiye" } },
        { "lat": "x", "lon": "1", "display_name": "broken" },
    ])
}

#[tokio::test(flavor = "multi_thread")]
async fn one_geocoder_request_a_second_and_answers_cached_on_disk() {
    let starts: Arc<Mutex<Vec<i64>>> = Arc::default();
    let clock_of: Arc<Mutex<Option<Arc<FakeClock>>>> = Arc::default();
    let (started, clock) = (starts.clone(), clock_of.clone());
    let server = Server::start(move |seen: &Seen| {
        if let Some(clock) = clock.lock().expect("clock").as_ref() {
            started.lock().expect("starts").push(eos_core::Clock::now_ms(clock.as_ref()));
        }
        if seen.target.starts_with("/reverse") {
            Reply::json(&json!({ "address": { "city": "Ankara", "country": "Türkiye" } }))
        } else {
            Reply::json(&search_rows())
        }
    })
    .await;
    let rig = rig(&server);
    *clock_of.lock().expect("clock") = Some(rig.clock.clone());
    let geo = &rig.services.geocoder;

    let (a, b, c) = tokio::join!(geo.search("Moda", 5), geo.search("Kadıköy", 5), geo.reverse(39.92077, 32.85411));
    let (a, b, c) = (a.expect("found"), b.expect("found"), c.expect("an area"));
    assert_eq!(a.len(), 1, "rows without a position are dropped");
    assert_eq!(
        serde_json::to_value(&a[0]).expect("json"),
        json!({ "lat": 40.9903, "lon": 29.029, "label": "Moda, Kadıköy, İstanbul, Türkiye",
                "area": { "district": "Moda", "city": "İstanbul", "country": "Türkiye" }, "kind": "suburb" })
    );
    assert_eq!(b.len(), 1);
    assert_eq!(serde_json::to_value(&c).expect("json"), json!({ "city": "Ankara", "country": "Türkiye" }));
    let starts = starts.lock().expect("starts").clone();
    assert_eq!([starts[1] - starts[0], starts[2] - starts[1]], [1000, 1000]);
    assert_eq!(*rig.sleeps.lock().expect("sleeps"), [1000, 1000]);
    for seen in server.seen() {
        assert!(seen.header("user-agent").is_some_and(|agent| agent.starts_with("eos/")));
        assert_eq!(seen.header("accept"), Some("application/json"));
    }

    // Repeats come from the cache (a reverse lookup is rounded to about 100 m).
    assert_eq!(geo.search("  moda ", 5).await.expect("cached").len(), 1);
    assert!(geo.reverse(39.9209, 32.8540).await.expect("cached").is_some());
    assert_eq!(server.targets().len(), 3);
    // …also after a restart: the answers are on disk.
    geo.flush().await;
    let Rig { home, .. } = rig;
    let again = rig_in(home, &server);
    assert_eq!(again.services.geocoder.search("Moda", 5).await.expect("from disk").len(), 1);
    assert_eq!(server.targets().len(), 3);
    assert!(again.home.join("media-cache/geo/nominatim.json").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_geocoder_asks_what_the_typescript_asks() {
    let server = Server::start(|seen: &Seen| {
        if seen.target.starts_with("/reverse") { Reply::json(&json!({})) } else { Reply::json(&json!([])) }
    })
    .await;
    let rig = rig(&server);
    let geo = &rig.services.geocoder;
    let real = "https://nominatim.openstreetmap.org";
    for call in vectors()["geocodeCalls"].as_array().expect("calls") {
        let before = server.targets().len();
        if let Some(q) = call["search"].as_str() {
            // The port takes a whole number (the route's schema says so); the TypeScript floors.
            #[allow(clippy::cast_possible_truncation)]
            let limit = call["limit"].as_f64().expect("limit").floor() as i64;
            assert_eq!(geo.search(q, limit).await.expect("answered"), []);
        } else {
            let at = &call["reverse"];
            let area = geo.reverse(at[0].as_f64().expect("lat"), at[1].as_f64().expect("lon")).await;
            assert_eq!(area.expect("answered"), None);
        }
        let asked = server.targets().get(before).cloned();
        let want = call["url"].as_str().map(|url| url.trim_start_matches(real).to_owned());
        assert_eq!(asked, want, "{call}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failing_geocoder_says_so_in_a_sentence() {
    let server = Server::start(|seen: &Seen| match seen.target.as_str() {
        t if t.contains("q=limited") => Reply::new(429, "text/plain", "slow down"),
        t if t.contains("q=down") => Reply::new(503, "text/plain", ""),
        _ => Reply::new(200, "application/json", b"<html>".to_vec()),
    })
    .await;
    let rig = rig(&server);
    let geo = &rig.services.geocoder;
    let message = |r: Result<Vec<eos_contracts::GeocodeResult>, eos_core::net::GeoError>| r.expect_err("failed").0;
    assert_eq!(message(geo.search("limited", 5).await), "OpenStreetMap geocoding answered 429 (rate limited)");
    assert_eq!(message(geo.search("down", 5).await), "OpenStreetMap geocoding answered 503");
    assert!(message(geo.search("garbled", 5).await).starts_with("OpenStreetMap geocoding failed: "));
    // A failure is not cached: the next ask goes out again.
    assert!(geo.search("down", 5).await.is_err());
    assert_eq!(server.targets().iter().filter(|t| t.contains("q=down")).count(), 2);
}

// ---- places -----------------------------------------------------------------

fn place_query(q: &Value) -> PlaceQuery {
    PlaceQuery {
        query: q["query"].as_str().map(str::to_owned),
        category: q["category"].as_str().map(str::to_owned),
        lat: q["center"]["lat"].as_f64().expect("lat"),
        lon: q["center"]["lon"].as_f64().expect("lon"),
        radius_m: q["radiusM"].as_f64().expect("radius"),
        limit: usize::try_from(q["limit"].as_u64().expect("limit")).expect("limit"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn places_are_asked_for_sorted_cut_and_cached_as_the_typescript_does() {
    let searches = vectors()["searches"].clone();
    let elements = searches[0]["elements"].clone();
    let server = Server::start(move |_: &Seen| Reply::json(&json!({ "elements": elements }))).await;
    let rig = rig(&server);
    for search in searches.as_array().expect("searches") {
        let q = place_query(&search["q"]);
        let places = rig.services.places.search(&q).await.expect("places");
        assert_eq!(Value::Array(places), search["places"], "{}", search["q"]);
        let asked = server.seen().pop().expect("a request");
        assert_eq!((asked.method.as_str(), asked.target.as_str()), ("POST", "/api/interpreter"));
        assert_eq!(Some(asked.body.as_str()), search["body"].as_str());
        assert_eq!(asked.header("content-type"), Some("application/x-www-form-urlencoded"));
    }
    let asked = server.targets().len();
    let again = place_query(&searches[0]["q"]);
    assert!(!rig.services.places.search(&again).await.expect("cached").is_empty());
    assert_eq!(server.targets().len(), asked, "the same search within a day asks nobody");
    rig.clock.advance(24 * 60 * 60 * 1000 + 1);
    rig.services.places.search(&again).await.expect("asked again");
    assert_eq!(server.targets().len(), asked + 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_busy_or_failing_place_search_says_so() {
    let server = Server::start(|seen: &Seen| match seen.body.as_str() {
        b if b.contains("busy") => Reply::new(429, "text/plain", ""),
        b if b.contains("late") => Reply::new(504, "text/plain", ""),
        _ => Reply::new(400, "text/plain", ""),
    })
    .await;
    let rig = rig(&server);
    let ask = |category: &str| PlaceQuery {
        query: None,
        category: Some(category.to_owned()),
        lat: 1.0,
        lon: 2.0,
        radius_m: 500.0,
        limit: 5,
    };
    let places = &rig.services.places;
    let busy = "OpenStreetMap place search is busy right now — try again in a minute";
    assert_eq!(places.search(&ask("busy")).await.expect_err("busy").0, busy);
    assert_eq!(places.search(&ask("late")).await.expect_err("busy").0, busy);
    assert_eq!(places.search(&ask("other")).await.expect_err("failed").0, "OpenStreetMap place search answered 400");
    let nothing = PlaceQuery { category: Some("  ".to_owned()), ..ask("x") };
    assert_eq!(places.search(&nothing).await.expect_err("refused").0, "a query or a category is needed");
}

// ---- images -----------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn images_and_preview_images_come_through_the_guarded_fetch() {
    let server = Server::start(|seen: &Seen| match seen.target.as_str() {
        "/a.png" => Reply::new(200, "image/png", PNG),
        "/item" => Reply::redirect("/item/1"),
        "/item/1" => Reply::new(
            200,
            "text/html; charset=utf-8",
            br#"<head><meta property="og:image" content="../hero.png"></head>"#.to_vec(),
        ),
        "/hero.png" => Reply::new(200, "application/octet-stream", PNG),
        "/page.html" => Reply::new(200, "text/html", b"<html>not an image</html>".to_vec()),
        _ => Reply::new(404, "text/plain", ""),
    })
    .await;
    let rig = rig(&server);
    let media = &rig.services.media;
    let url = |path: &str| format!("{}{path}", server.origin());

    let image = media.image(&url("/a.png")).await.expect("an image");
    assert_eq!((image.content_type.as_str(), &image.body[..]), ("image/png", PNG));
    let asked = &server.seen()[0];
    assert!(asked.header("user-agent").is_some_and(|agent| agent.starts_with("eos/")));
    assert_eq!(asked.header("accept"), Some("image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8"));
    // Cached on disk under its key, in today's layout.
    assert!(media.image(&url("/a.png")).await.is_some());
    assert_eq!(server.targets(), ["/a.png"]);
    let files: Vec<String> = std::fs::read_dir(rig.home.join("media-cache"))
        .expect("the cache folder")
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(files.iter().filter(|f| f.ends_with(".bin")).count(), 1);
    assert_eq!(files.iter().filter(|f| f.ends_with(".json")).count(), 1);

    // The preview image resolves against the URL that answered after the redirect.
    let preview = media.og(&url("/item")).await.expect("the preview image");
    assert_eq!(preview.content_type, "image/png", "sniffed");
    assert_eq!(server.targets()[1..], ["/item", "/item/1", "/hero.png"]);

    assert_eq!(media.image(&url("/page.html")).await, None, "a page is not an image");
    assert_eq!(media.image(&url("/missing.png")).await, None);
    assert_eq!(media.image("not a url").await, None);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_url_into_this_computer_or_the_local_network_is_never_fetched() {
    let server = Server::start(|_: &Seen| Reply::new(200, "image/png", PNG)).await;
    // The real address rules: loopback is not "public" here.
    let options = Options { endpoints: Endpoints::default(), ..Options::new().expect("options") };
    let home = TempHome::new();
    let services = build(&home.join("media-cache"), Arc::new(FakeClock::new()), options).expect("the adapters");
    for url in [
        format!("{}/a.png", server.origin()),
        format!("http://localhost:{}/a.png", server.addr.port()),
        "http://169.254.169.254/latest/meta-data/".to_owned(),
        "http://10.0.0.1/a.png".to_owned(),
        "http://[::1]/a.png".to_owned(),
        "file:///etc/passwd".to_owned(),
    ] {
        assert_eq!(services.media.image(&url).await, None, "{url}");
        assert_eq!(services.media.og(&url).await, None, "{url}");
    }
    assert!(server.seen().is_empty(), "nothing reached the local server");
}
