//! The boot snapshot over the composed app: each part is what its own route answers the
//! same caller, byte for byte, and the snapshot is guarded as strictly as its strictest part.

use std::sync::Arc;

use eos_app::{App, Options};
use eos_contracts::{BOOT_PARTS, BootSnapshot, boot_page_target};
use eos_runtime::access::{Access, Caller, LocalRule, PeerRule};
use eos_runtime::http::{Method, Request};
use eos_testkit::{FakeClock, SeqIds, TempHome};

async fn started(home: &TempHome) -> App {
    let options = Options {
        clock: Arc::new(FakeClock::new()),
        ids: Arc::new(SeqIds::new()),
        env: Default::default(),
        ..Options::new(home.path())
    };
    let app = App::build(options).expect("builds");
    app.start().await.expect("starts");
    app
}

async fn get(app: &App, target: &str, caller: &Caller) -> (u16, Vec<u8>) {
    let res = app.router().handle(Request::new(Method::Get, target, caller.clone())).await;
    (res.status, res.body.collect().await.expect("a body").to_vec())
}

#[tokio::test(flavor = "multi_thread")]
async fn every_part_is_what_its_own_route_answers() {
    let home = TempHome::new();
    let sandbox = home.join("sandbox").to_string_lossy().into_owned();
    for project in ["alpha", "beta"] {
        std::fs::create_dir_all(format!("{sandbox}/{project}")).expect("a project folder");
    }
    let home = home.with_seed(&sandbox);
    let app = started(&home).await;
    let dashboard = app.callers().classify(Some(app.callers().ui_token()));

    let (status, body) = get(&app, "/api/boot?focus=w-BUSY", &dashboard).await;
    assert_eq!(status, 200);
    let snapshot: BootSnapshot = serde_json::from_slice(&body).expect("the snapshot shape");
    let mut expected: Vec<String> = BOOT_PARTS.iter().map(|t| (*t).to_owned()).collect();
    expected.push(boot_page_target("w-BUSY"));
    assert_eq!(snapshot.parts.keys().cloned().collect::<Vec<_>>(), expected, "every part, in order");
    for (target, answer) in &snapshot.parts {
        let (status, body) = get(&app, target, &dashboard).await;
        assert_eq!(answer.status, status, "{target}");
        assert_eq!(answer.body.get().as_bytes(), body.as_slice(), "{target}: the same bytes");
    }
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(snapshot.parts[&boot_page_target("w-BUSY")].body.get()).expect("rows");
    assert!(!rows.is_empty(), "the seeded chat has a page");
}

/// The strictest of two rules: the user's token over any page, the local plane over a
/// paired computer's dashboard over everyone, no phone over any tier.
fn stricter(a: Access, b: Access) -> Access {
    let local =
        if a.local == LocalRule::UiToken || b.local == LocalRule::UiToken { LocalRule::UiToken } else { a.local };
    let rank = |p: PeerRule| match p {
        PeerRule::Open => 0,
        PeerRule::Human => 1,
        PeerRule::LocalOnly => 2,
    };
    let peer = if rank(a.peer) >= rank(b.peer) { a.peer } else { b.peer };
    let phone = match (a.phone, b.phone) {
        (Some(x), Some(y)) => Some(if x.tier >= y.tier { x } else { y }),
        _ => None,
    };
    Access { local, peer, phone }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_snapshot_is_guarded_as_strictly_as_its_strictest_part() {
    let home = TempHome::new();
    let app = started(&home).await;
    let router = app.router();
    let mut targets: Vec<String> = BOOT_PARTS.iter().map(|t| (*t).to_owned()).collect();
    targets.push(boot_page_target("w-1"));
    let strictest = targets
        .iter()
        .map(|t| router.access_of(Method::Get, t).unwrap_or_else(|| panic!("{t} is a route with a rule")))
        .reduce(stricter)
        .expect("parts");
    assert_eq!(router.access_of(Method::Get, "/api/boot"), Some(strictest));
}
