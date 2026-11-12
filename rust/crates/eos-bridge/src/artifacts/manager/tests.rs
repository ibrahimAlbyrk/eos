//! The view pool against a surface that records what it is told
//! (`app/src/main/artifacts` behaviour). Time is the runtime's paused clock: a timer fires
//! when the test has nothing else to do.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use eos_core::BoxFuture;
use eos_core::shell::Rect;
use serde_json::{Value, json};

use super::super::stills::StillStore;
use super::super::urls::Viewer;
use super::super::{ArtifactRef, ArtifactSurface, SurfaceEvent, ViewState};
use super::ArtifactViews;
use crate::testdir::Dir;

const A: &str = "0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const B: &str = "5d7c1e40-9a1b-4c2d-8e3f-1a2b3c4d5e6f";
const VIEWER_A: &str = "https://claude.ai/artifact/2NC37Mk7spnA7bv13mCd5k";

#[derive(Default)]
struct Fake {
    calls: Mutex<Vec<String>>,
    signed_in: Mutex<HashSet<String>>,
    hidden_window: AtomicBool,
    can_go_back: AtomicBool,
}

impl Fake {
    fn record(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }

    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
}

fn done<'a, T: Send + 'a>(value: T) -> BoxFuture<'a, T> {
    Box::pin(async move { value })
}

fn rect(r: Rect) -> String {
    format!("{},{},{},{}", r.x, r.y, r.width, r.height)
}

impl ArtifactSurface for Fake {
    fn create(&self, view: u64, profile: &str) -> BoxFuture<'_, Result<(), String>> {
        self.record(format!("create {view} {profile}"));
        done(Ok(()))
    }
    fn navigate(&self, view: u64, url: &str) -> BoxFuture<'_, ()> {
        self.record(format!("navigate {view} {url}"));
        done(())
    }
    fn show(&self, view: u64, r: Rect, radius: f64) -> BoxFuture<'_, ()> {
        self.record(format!("show {view} {} r{radius}", rect(r)));
        done(())
    }
    fn hide(&self, view: u64, size: (f64, f64)) -> BoxFuture<'_, ()> {
        self.record(format!("hide {view} {}x{}", size.0, size.1));
        done(())
    }
    fn set_peek(&self, view: u64, peek: bool) -> BoxFuture<'_, ()> {
        self.record(format!("peek {view} {peek}"));
        done(())
    }
    fn set_muted(&self, view: u64, muted: bool) -> BoxFuture<'_, ()> {
        self.record(format!("mute {view} {muted}"));
        done(())
    }
    fn go_back(&self, view: u64) -> BoxFuture<'_, bool> {
        self.record(format!("back {view}"));
        done(self.can_go_back.load(Ordering::SeqCst))
    }
    fn capture(&self, view: u64) -> BoxFuture<'_, Option<Vec<u8>>> {
        self.record(format!("capture {view}"));
        done(Some(b"\xff\xd8still".to_vec()))
    }
    fn close(&self, view: u64) -> BoxFuture<'_, ()> {
        self.record(format!("close {view}"));
        done(())
    }
    fn signed_in(&self, profile: &str) -> BoxFuture<'_, bool> {
        done(self.signed_in.lock().unwrap().contains(profile))
    }
    fn sign_in(&self, profile: &str) -> BoxFuture<'_, bool> {
        self.record(format!("sign-in {profile}"));
        self.signed_in.lock().unwrap().insert(profile.to_owned());
        done(true)
    }
    fn sign_out(&self, profile: &str) -> BoxFuture<'_, ()> {
        self.record(format!("sign-out {profile}"));
        self.signed_in.lock().unwrap().remove(profile);
        done(())
    }
    fn open_external(&self, url: &str) {
        self.record(format!("open {url}"));
    }
    fn window_on_screen(&self) -> bool {
        !self.hidden_window.load(Ordering::SeqCst)
    }
}

struct Bench {
    views: ArtifactViews,
    surface: Arc<Fake>,
    events: Arc<Mutex<Vec<(String, Value)>>>,
    _dir: Dir,
    stills: StillStore,
}

fn bench() -> Bench {
    let dir = Dir::new("artifact-views");
    let surface = Arc::new(Fake::default());
    surface.signed_in.lock().unwrap().insert("claude-lg-1".into());
    let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let sink = events.clone();
    let stills = StillStore::new(dir.path().join("stills"));
    let views = ArtifactViews::start(
        surface.clone(),
        Viewer::default(),
        stills.clone(),
        Arc::new(move |name, payload| sink.lock().unwrap().push((name.to_owned(), payload))),
        &tokio::runtime::Handle::current(),
    );
    Bench { views, surface, events, _dir: dir, stills }
}

fn art(slug: &str) -> ArtifactRef {
    ArtifactRef { slug: slug.into(), login_id: Some("lg-1".into()), version: Some("v1".into()) }
}

fn at(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect { x, y, width, height }
}

impl Bench {
    /// Lets the side work (sign-in checks, captures) land and the pool take it.
    async fn settle(&self) {
        for _ in 0..8 {
            tokio::task::yield_now().await;
            self.views.status().await;
        }
    }

    fn states(&self) -> Vec<String> {
        self.events
            .lock()
            .unwrap()
            .drain(..)
            .map(|(name, p)| {
                let slug = p["slug"].as_str().unwrap_or("").get(..1).unwrap_or("").to_owned();
                let what = p.get("state").or(p.get("action")).and_then(Value::as_str).unwrap_or("").to_owned();
                if name == "artifacts:action" { format!("{slug}!{what}") } else { format!("{slug}:{what}") }
            })
            .collect()
    }

    /// The view's page loaded and painted.
    async fn ready(&self, view: u64) {
        self.views.surface_event(view, SurfaceEvent::DomReady);
        self.views.surface_event(view, SurfaceEvent::Loaded);
        self.settle().await;
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        self.settle().await;
    }
}

#[tokio::test(start_paused = true)]
async fn a_warm_view_loads_off_screen_becomes_ready_and_leaves_a_still() {
    let b = bench();
    b.views.warm(art(A)).await;
    b.settle().await;
    assert_eq!(b.surface.take(), ["create 1 claude-lg-1", "mute 1 true", format!("navigate 1 {VIEWER_A}").as_str()]);
    assert_eq!(b.states(), ["0:loading"]);
    assert_eq!(b.views.state(A.into()).await, ViewState::Loading);
    b.ready(1).await;
    assert_eq!(b.states(), ["0:ready"]);
    assert!(b.surface.take().iter().all(|c| !c.starts_with("show")), "never placed, never shown");
    // The still is taken once the page settled, then announced again.
    tokio::time::sleep(std::time::Duration::from_millis(1600)).await;
    b.settle().await;
    assert_eq!(b.surface.take(), ["capture 1"]);
    assert_eq!(b.states(), ["0:ready"]);
    assert!(b.stills.has(A, Some("v1")));
    assert_eq!(b.views.still(art(A)).await.as_deref(), Some("data:image/jpeg;base64,/9hzdGlsbA=="));
    assert_eq!(b.views.still(art(B)).await, None);
}

#[tokio::test(start_paused = true)]
async fn a_profile_without_a_sign_in_asks_for_one_and_loads_once_signed_in() {
    let b = bench();
    let other = ArtifactRef { login_id: Some("lg-2".into()), ..art(A) };
    b.views.warm(other.clone()).await;
    b.settle().await;
    assert_eq!(b.surface.take(), ["create 1 claude-lg-2", "mute 1 true"]);
    assert_eq!(b.states(), ["0:signin"]);
    assert_eq!(b.views.account(Some("lg-2".into())).await, json!({ "signedIn": false }));
    assert_eq!(b.views.sign_in(Some("lg-2".into())).await, json!({ "signedIn": true }));
    b.settle().await;
    assert_eq!(b.surface.take(), ["sign-in claude-lg-2", format!("navigate 1 {VIEWER_A}").as_str()]);
    assert_eq!(b.states(), ["0:loading"]);
    b.ready(1).await;
    b.views.sign_out(Some("lg-2".into())).await;
    b.settle().await;
    let calls = b.surface.take();
    assert!(calls.contains(&"sign-out claude-lg-2".to_owned()) && calls.contains(&"navigate 1 about:blank".to_owned()));
    assert_eq!(b.states(), ["0:ready", "0:signin"]);
}

#[tokio::test(start_paused = true)]
async fn one_view_moves_from_peek_to_tab_without_a_reload() {
    let b = bench();
    b.views.peek(art(A), at(10.0, 20.0, 300.0, 200.0)).await;
    b.settle().await;
    let calls = b.surface.take();
    assert!(calls.contains(&"peek 1 true".to_owned()), "{calls:?}");
    assert!(calls.contains(&"hide 1 300x200".to_owned()), "laid out at the peek's size while it loads: {calls:?}");
    b.ready(1).await;
    assert_eq!(b.surface.take(), ["show 1 10,20,300,200 r10"]);
    // A click on the shield opens the artifact; ⌥ opens claude.ai.
    b.views.surface_event(1, SurfaceEvent::Shield { external: false });
    b.views.surface_event(1, SurfaceEvent::Shield { external: true });
    b.settle().await;
    assert_eq!(b.surface.take(), [format!("open {VIEWER_A}")]);

    b.views.attach("artifact:a".into(), art(A), at(400.0, 50.0, 600.0, 700.0)).await;
    b.settle().await;
    assert_eq!(b.surface.take(), ["peek 1 false", "show 1 400,50,600,700 r9", "mute 1 false"]);
    assert_eq!(b.states(), ["0:loading", "0:ready", "0!open"]);
    // Off the peek, a shield click means nothing.
    b.views.surface_event(1, SurfaceEvent::Shield { external: false });
    b.settle().await;
    assert!(b.states().is_empty());

    b.views.set_bounds("artifact:a".into(), at(400.0, 50.0, 500.0, 700.0)).await;
    b.views.set_visible("artifact:a".into(), false).await;
    b.views.set_visible("artifact:a".into(), true).await;
    b.settle().await;
    assert_eq!(
        b.surface.take(),
        ["show 1 400,50,500,700 r9", "hide 1 500x700", "mute 1 true", "show 1 400,50,500,700 r9", "mute 1 false"]
    );
    // Peeking a tab's own artifact takes the view; unpeeking hands it back.
    b.views.peek(art(A), at(0.0, 0.0, 200.0, 100.0)).await;
    b.views.unpeek().await;
    b.settle().await;
    assert_eq!(
        b.surface.take(),
        [
            "peek 1 true",
            "show 1 0,0,200,100 r10",
            "mute 1 true",
            "peek 1 false",
            "show 1 400,50,500,700 r9",
            "mute 1 false"
        ]
    );
    b.views.detach("artifact:a".into()).await;
    b.settle().await;
    assert_eq!(b.surface.take(), ["hide 1 1280x800", "mute 1 true"]);
    assert!(!b.surface.calls.lock().unwrap().iter().any(|c| c.starts_with("navigate")), "never reloaded");
}

#[tokio::test(start_paused = true)]
async fn a_ready_view_reloads_behind_itself_and_the_two_swap() {
    let b = bench();
    b.views.attach("t".into(), art(A), at(0.0, 0.0, 600.0, 400.0)).await;
    b.settle().await;
    b.ready(1).await;
    b.surface.take();
    b.states();
    b.views.reload(A.into()).await;
    b.settle().await;
    assert_eq!(b.surface.take(), ["create 2 claude-lg-1", "mute 2 true", format!("navigate 2 {VIEWER_A}").as_str()]);
    assert!(b.states().is_empty(), "the view on screen stays as it is");
    assert_eq!(b.views.state(A.into()).await, ViewState::Ready);
    b.ready(2).await;
    assert_eq!(b.surface.take(), ["show 2 0,0,600,400 r9", "mute 2 false", "close 1"]);
    // The replacement is the artifact's view now.
    b.views.set_bounds("t".into(), at(0.0, 0.0, 500.0, 400.0)).await;
    b.settle().await;
    assert_eq!(b.surface.take(), ["show 2 0,0,500,400 r9"]);
}

#[tokio::test(start_paused = true)]
async fn a_replacement_that_fails_is_reported_on_the_view_on_screen() {
    let b = bench();
    b.views.warm(art(A)).await;
    b.settle().await;
    b.ready(1).await;
    b.views.reload(A.into()).await;
    b.settle().await;
    b.states();
    b.views.surface_event(2, SurfaceEvent::Failed { description: "net::ERR_INTERNET_DISCONNECTED".into() });
    b.settle().await;
    assert!(b.surface.take().contains(&"close 2".to_owned()));
    assert_eq!(b.states(), ["0:error"]);
}

#[tokio::test(start_paused = true)]
async fn a_new_version_reloads_and_the_pool_keeps_four_unplaced_views() {
    let b = bench();
    b.views.warm(art(A)).await;
    b.settle().await;
    b.ready(1).await;
    b.surface.take();
    b.views.warm(ArtifactRef { version: Some("v2".into()), ..art(A) }).await;
    b.settle().await;
    assert!(b.surface.take().contains(&"create 2 claude-lg-1".to_owned()), "a newer version loads behind");

    let b = bench();
    let slugs: Vec<String> = (0..6).map(|n| format!("0b0e8f2a-1c2d-4e5f-8a9b-0c1d2e3f4a5{n}")).collect();
    for slug in &slugs {
        b.views.warm(art(slug)).await;
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    b.settle().await;
    let closed: Vec<String> = b.surface.take().into_iter().filter(|c| c.starts_with("close")).collect();
    assert_eq!(closed, ["close 1", "close 2"], "the least recently used go");
    assert!(b.states().iter().filter(|s| s.ends_with(":idle")).count() == 2);
    // Five idle minutes close every view no tab holds.
    b.views.attach("t".into(), art(&slugs[5]), at(0.0, 0.0, 10.0, 10.0)).await;
    tokio::time::sleep(std::time::Duration::from_secs(6 * 60)).await;
    b.settle().await;
    let closed: Vec<String> = b.surface.take().into_iter().filter(|c| c.starts_with("close")).collect();
    assert_eq!(closed, ["close 3", "close 4", "close 5"]);
}

#[tokio::test(start_paused = true)]
async fn navigation_off_the_viewer_never_stays_in_the_view() {
    let b = bench();
    b.views.warm(art(A)).await;
    b.settle().await;
    b.views.surface_event(1, SurfaceEvent::Refused { url: "https://evil.com/".into() });
    b.settle().await;
    assert_eq!(b.states(), ["0:loading", "0:error"]);

    let b = bench();
    b.views.attach("t".into(), art(A), at(0.0, 0.0, 600.0, 400.0)).await;
    b.settle().await;
    b.ready(1).await;
    b.surface.take();
    b.views.surface_event(1, SurfaceEvent::Refused { url: "https://example.com/docs".into() });
    b.views.surface_event(1, SurfaceEvent::OpenRequested { url: "https://example.com/new".into() });
    b.views.surface_event(1, SurfaceEvent::OpenRequested { url: "file:///etc/passwd".into() });
    b.settle().await;
    assert_eq!(b.surface.take(), ["open https://example.com/docs", "open https://example.com/new"]);
    b.surface.can_go_back.store(true, Ordering::SeqCst);
    b.views.surface_event(1, SurfaceEvent::InPage { url: "https://claude.ai/chat/x".into() });
    b.settle().await;
    assert_eq!(b.surface.take(), ["open https://claude.ai/chat/x", "back 1"]);
    b.states();
    b.views.surface_event(1, SurfaceEvent::Navigated { url: "https://claude.ai/login?r=1".into() });
    b.settle().await;
    assert_eq!(b.states(), ["0:signin"]);
    assert!(b.surface.take().contains(&"hide 1 600x400".to_owned()), "a view that is not ready is not shown");
}

#[tokio::test(start_paused = true)]
async fn a_page_that_never_finishes_loading_is_shown_once_it_has_its_dom() {
    let b = bench();
    b.views.warm(art(A)).await;
    b.views.warm(art(B)).await;
    b.settle().await;
    b.views.surface_event(1, SurfaceEvent::DomReady);
    tokio::time::sleep(std::time::Duration::from_secs(31)).await;
    b.settle().await;
    let mut states = b.states();
    states.sort();
    assert_eq!(states, ["0:loading", "0:ready", "5:error", "5:loading"]);
}

#[tokio::test(start_paused = true)]
async fn views_stay_hidden_while_another_computer_covers_the_dashboard() {
    let b = bench();
    b.views.attach("t".into(), art(A), at(0.0, 0.0, 600.0, 400.0)).await;
    b.settle().await;
    b.ready(1).await;
    b.surface.take();
    b.views.set_covered(true).await;
    b.settle().await;
    assert_eq!(b.surface.take(), ["hide 1 600x400", "mute 1 true"]);
    b.views.set_covered(false).await;
    b.settle().await;
    assert_eq!(b.surface.take(), ["show 1 0,0,600,400 r9", "mute 1 false"]);
    assert_eq!(
        b.views.status().await["views"][0],
        json!({ "state": "ready", "place": "tab", "shown": true, "replacing": false })
    );
}
