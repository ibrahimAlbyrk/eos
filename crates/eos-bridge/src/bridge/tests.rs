use std::sync::atomic::AtomicBool;
use std::time::Duration;

use eos_core::BoxFuture;
use eos_core::shell::{BrowserViews, Image, ViewError, ViewListener, ViewSpec};

use super::*;
use crate::core::LateCore;
use crate::testdir::Dir;
use crate::transport::{Body, Initiator, Read, channel};

const TOKEN: &str = "ui-token-for-tests";

#[derive(Default)]
struct FakeCore {
    seen: Mutex<Vec<(Plane, Req)>>,
}

impl Core for FakeCore {
    fn ui_token(&self) -> String {
        TOKEN.to_string()
    }

    fn call(&self, plane: Plane, req: Req, sink: Sink) {
        let body = format!("{plane:?} {} {}", req.method, req.url);
        self.seen.lock().unwrap().push((plane, req));
        sink.respond(200, vec![("content-type".into(), "text/plain".into())], body.as_bytes());
    }
}

#[derive(Default)]
struct FakeHost {
    focused: AtomicBool,
    calls: Mutex<Vec<String>>,
    banners: Mutex<Vec<Banner>>,
    downloads: Mutex<PathBuf>,
    /// The login item as the system would report it.
    login: Mutex<Option<LoginItem>>,
}

impl FakeHost {
    fn log(&self, call: impl Into<String>) {
        self.calls.lock().unwrap().push(call.into());
    }
}

impl ShellHost for FakeHost {
    fn start_window_drag(&self) {
        self.log("drag");
    }
    fn toggle_window_zoom(&self) {
        self.log("zoom");
    }
    fn window_focused(&self) -> bool {
        self.focused.load(Ordering::SeqCst)
    }
    fn set_theme(&self, theme: Theme) {
        self.log(format!("theme {}", theme.name()));
    }
    fn show_banner(&self, banner: Banner) {
        self.banners.lock().unwrap().push(banner);
    }
    fn clipboard_text(&self) -> Option<String> {
        Some("clip".into())
    }
    fn set_clipboard_text(&self, text: &str) {
        self.log(format!("copy {text}"));
    }
    fn clipboard_file_paths(&self) -> Vec<String> {
        vec![self.downloads.lock().unwrap().to_string_lossy().into_owned(), "/no/such/file.txt".into(), String::new()]
    }
    fn clipboard_has_files(&self) -> bool {
        false
    }
    fn dropped_file_paths(&self) -> Vec<String> {
        vec!["/no/such/dropped.png".into()]
    }
    fn edit(&self, command: EditCommand) {
        self.log(format!("edit {}", command.name()));
    }
    fn open_path(&self, path: &Path) {
        self.log(format!("open {}", path.file_name().unwrap().to_string_lossy()));
    }
    fn downloads_dir(&self) -> PathBuf {
        self.downloads.lock().unwrap().clone()
    }
    fn login_item(&self) -> LoginItem {
        self.login.lock().unwrap().unwrap_or(LoginItem::Off)
    }
    fn set_login_item(&self, on: bool) -> LoginItem {
        self.log(format!("login {on}"));
        // A first registration waits for the user's approval, as macOS asks for it.
        let state = if on { LoginItem::NeedsApproval } else { LoginItem::Off };
        *self.login.lock().unwrap() = Some(state);
        state
    }
    fn open_login_items_settings(&self) {
        self.log("login settings");
    }
}

#[derive(Default)]
struct FakeViews {
    calls: Mutex<Vec<String>>,
}

impl BrowserViews for FakeViews {
    fn create(&self, _spec: ViewSpec) -> BoxFuture<'_, Result<ViewId, ViewError>> {
        Box::pin(async { Ok(ViewId("v".into())) })
    }
    fn close(&self, _v: &ViewId) -> BoxFuture<'_, Result<(), ViewError>> {
        Box::pin(async { Ok(()) })
    }
    fn place(&self, v: &ViewId, r: Rect) -> BoxFuture<'_, Result<(), ViewError>> {
        self.calls.lock().unwrap().push(format!("place {v} {},{} {}x{}", r.x, r.y, r.width, r.height));
        Box::pin(async { Ok(()) })
    }
    fn park(&self, v: &ViewId) -> BoxFuture<'_, Result<(), ViewError>> {
        self.calls.lock().unwrap().push(format!("park {v}"));
        Box::pin(async { Ok(()) })
    }
    fn set_muted(&self, _v: &ViewId, _muted: bool) -> BoxFuture<'_, Result<(), ViewError>> {
        Box::pin(async { Ok(()) })
    }
    fn allow_local_network(&self, _v: &ViewId, _host: &str) -> BoxFuture<'_, Result<(), ViewError>> {
        Box::pin(async { Ok(()) })
    }
    fn cdp(&self, _v: &ViewId, _method: &str, _params: Value) -> BoxFuture<'_, Result<Value, ViewError>> {
        Box::pin(async { Ok(Value::Null) })
    }
    fn listen(&self, _listener: Arc<dyn ViewListener>) {}
}

struct FakeCapture;

impl Capture for FakeCapture {
    fn capture(&self, target: CaptureTarget, format: ImageFormat) -> BoxFuture<'_, Result<Image, ViewError>> {
        Box::pin(async move {
            match target {
                CaptureTarget::Dashboard => Ok(Image { format, bytes: b"dash".to_vec() }),
                CaptureTarget::View(view) => Ok(Image { format, bytes: view.0.into_bytes() }),
            }
        })
    }
}

struct World {
    _dir: Dir,
    data: PathBuf,
    bridge: Arc<Bridge>,
    core: Arc<FakeCore>,
    host: Arc<FakeHost>,
    views: Arc<FakeViews>,
}

fn world_with(seed: Option<Seed>) -> World {
    world_over(seed, |core| core)
}

/// `wrap`: what the bridge is given in place of the fake core.
fn world_over(seed: Option<Seed>, wrap: impl FnOnce(Arc<FakeCore>) -> Arc<dyn Core>) -> World {
    let dir = Dir::new("bridge");
    let dist = dir.path().join("dist");
    std::fs::create_dir_all(dist.join("assets")).unwrap();
    std::fs::write(dist.join("index.html"), "<html><head></head><body>dashboard</body></html>").unwrap();
    std::fs::write(dist.join("assets/app.js"), "console.log(1)").unwrap();
    let data = dir.path().join("data");
    let downloads = dir.path().join("downloads");
    std::fs::create_dir_all(&downloads).unwrap();
    let core = Arc::new(FakeCore::default());
    let host = Arc::new(FakeHost::default());
    *host.downloads.lock().unwrap() = downloads;
    let views = Arc::new(FakeViews::default());
    let bridge = Bridge::new(Parts {
        assets: dist,
        data_dir: data.clone(),
        core: wrap(core.clone()),
        host: host.clone(),
        panel: Panel::new(views.clone(), &tokio::runtime::Handle::current()),
        capture: Arc::new(FakeCapture),
        rt: tokio::runtime::Handle::current(),
        seed,
        now_ms: || 1_700_000_000_000,
    });
    World { _dir: dir, data, bridge, core, host, views }
}

fn world() -> World {
    world_with(None)
}

struct Answer {
    status: u16,
    head: Head,
    body: Vec<u8>,
}

impl Answer {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("json body")
    }
}

use crate::transport::Head;

async fn read_to_end(body: &Body) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    for _ in 0..400 {
        match body.read(&mut buf, || {}) {
            Read::Data(n) => out.extend_from_slice(&buf[..n]),
            Read::End => return out,
            Read::Pending => tokio::time::sleep(Duration::from_millis(5)).await,
        }
    }
    panic!("the body never ended");
}

async fn call(bridge: &Bridge, method: &str, url: &str, headers: &[(&str, &str)], body: &[u8]) -> Answer {
    call_from(bridge, Initiator::Document, method, url, headers, body).await
}

async fn call_from(
    bridge: &Bridge,
    initiator: Initiator,
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Answer {
    let (sink, reader) = channel();
    let req = Req {
        initiator,
        method: method.into(),
        url: url.into(),
        headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
        body: body.to_vec(),
    };
    bridge.call(req, sink);
    let body = read_to_end(&reader).await;
    let head = reader.head().expect("head");
    Answer { status: head.status, head, body }
}

async fn bridge_call(w: &World, path: &str, body: Value) -> Answer {
    call(
        &w.bridge,
        "POST",
        &format!("http://eos.localhost/_shell/{path}"),
        &[("x-eos-ui-token", TOKEN)],
        body.to_string().as_bytes(),
    )
    .await
}

// ---- the URL space ---------------------------------------------------------------

#[tokio::test]
async fn core_requests_reach_the_api_router_without_the_prefix() {
    let w = world();
    let a = call(
        &w.bridge,
        "POST",
        "http://eos.localhost/_core/workers/w1/message?x=1",
        &[("content-type", "application/json")],
        b"{}",
    )
    .await;
    assert_eq!((a.status, a.text().as_str()), (200, "Api POST /workers/w1/message?x=1"));
    let seen = w.core.seen.lock().unwrap();
    assert_eq!(seen[0].1.body, b"{}");
    assert_eq!(seen[0].1.header("content-type"), Some("application/json"));
}

#[tokio::test]
async fn the_raw_host_reaches_the_raw_router() {
    let w = world();
    let a = call(&w.bridge, "GET", "http://raw.eos.localhost/fs/raw?path=%2Fa.pdf", &[], b"").await;
    assert_eq!(a.text(), "Raw GET /fs/raw?path=%2Fa.pdf");
}

#[tokio::test]
async fn plugin_builds_are_read_only_core_files() {
    let w = world();
    let a = call(&w.bridge, "GET", "http://eos.localhost/plugins/clock/3.js", &[], b"").await;
    assert_eq!(a.text(), "Api GET /ui/plugins/clock/3.js");
    assert_eq!(call(&w.bridge, "POST", "http://eos.localhost/plugins/clock/3.js", &[], b"").await.status, 405);
    assert_eq!(call(&w.bridge, "GET", "http://eos.localhost/plugins/clock/readme.md", &[], b"").await.status, 404);
}

#[tokio::test]
async fn other_hosts_get_nothing() {
    let w = world();
    assert_eq!(call(&w.bridge, "GET", "http://evil.example/_core/health", &[], b"").await.status, 404);
    assert!(w.core.seen.lock().unwrap().is_empty());
}

// ---- the token rule --------------------------------------------------------------

#[tokio::test]
async fn only_the_top_level_document_gets_the_bridge_script() {
    let w = world();
    let top = call_from(&w.bridge, Initiator::TopLevel, "GET", "http://eos.localhost/index.html", &[], b"").await;
    assert!(top.text().contains(TOKEN), "the dashboard's own load carries the token");
    assert!(top.text().starts_with("<html><head><script>"));
    assert!(top.head.header("content-security-policy").is_some());
    // A frame (a sandboxed app, a raw file) that loads the same document gets it as built,
    // and so does a fetch or a script element, whatever the page claims in its headers.
    for initiator in [Initiator::Frame, Initiator::Document] {
        let other =
            call_from(&w.bridge, initiator, "GET", "http://eos.localhost/", &[("sec-fetch-dest", "document")], b"")
                .await;
        assert_eq!(other.status, 200);
        assert!(!other.text().contains(TOKEN), "{initiator:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn while_the_core_starts_files_are_served_and_the_entry_document_and_core_requests_wait() {
    let late = Arc::new(LateCore::new(TOKEN.into()));
    let w = world_over(None, |_| late.clone());
    let entry = {
        let bridge = w.bridge.clone();
        tokio::spawn(async move {
            call_from(&bridge, Initiator::TopLevel, "GET", "http://eos.localhost/index.html", &[], b"").await
        })
    };
    let health = {
        let bridge = w.bridge.clone();
        tokio::spawn(async move { call(&bridge, "GET", "http://eos.localhost/_core/health", &[], b"").await })
    };
    let file = call(&w.bridge, "GET", "http://eos.localhost/assets/app.js", &[], b"").await;
    assert_eq!((file.status, file.text().as_str()), (200, "console.log(1)"));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!entry.is_finished() && !health.is_finished());
    assert!(w.core.seen.lock().unwrap().is_empty());

    late.settle(Some(w.core.clone()));
    let entry = entry.await.unwrap();
    assert_eq!(entry.status, 200);
    assert!(entry.text().contains(TOKEN), "the token the core checks");
    let health = health.await.unwrap();
    assert_eq!((health.status, health.text().as_str()), (200, "Api GET /health"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_core_that_did_not_start_leaves_the_dashboard_as_without_a_core() {
    let late = Arc::new(LateCore::new(TOKEN.into()));
    let w = world_over(None, |_| late.clone());
    let health = {
        let bridge = w.bridge.clone();
        tokio::spawn(async move { call(&bridge, "GET", "http://eos.localhost/_core/health", &[], b"").await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    late.settle(None);
    assert_eq!(health.await.unwrap().status, 503);
    let entry = call_from(&w.bridge, Initiator::TopLevel, "GET", "http://eos.localhost/index.html", &[], b"").await;
    assert!(!entry.text().contains(TOKEN));
    assert_eq!(bridge_call(&w, "window/startDragging", Value::Null).await.status, 403);
}

#[tokio::test]
async fn no_response_ever_allows_another_origin_to_read_it() {
    let w = world();
    for url in ["http://eos.localhost/", "http://eos.localhost/assets/app.js", "http://eos.localhost/_shell/ping"] {
        let a = call_from(&w.bridge, Initiator::TopLevel, "GET", url, &[("origin", "null")], b"").await;
        assert!(a.head.headers.iter().all(|(k, _)| !k.to_ascii_lowercase().starts_with("access-control-")), "{url}");
    }
}

#[tokio::test]
async fn a_frame_cannot_use_a_bridge_even_with_the_token() {
    let w = world();
    let url = "http://eos.localhost/_shell/window/startDragging";
    for initiator in [Initiator::Frame, Initiator::TopLevel] {
        assert_eq!(
            call_from(&w.bridge, initiator, "POST", url, &[("x-eos-ui-token", TOKEN)], b"null").await.status,
            403,
            "{initiator:?}"
        );
    }
    let events = format!("http://eos.localhost/_shell/events?t={TOKEN}");
    assert_eq!(call_from(&w.bridge, Initiator::Frame, "GET", &events, &[], b"").await.status, 403);
    assert!(w.host.calls.lock().unwrap().is_empty());
    assert_eq!(w.bridge.events().subscribers(), 0);
}

#[tokio::test]
async fn bridges_need_the_token() {
    let w = world();
    let url = "http://eos.localhost/_shell/window/startDragging";
    assert_eq!(call(&w.bridge, "POST", url, &[], b"null").await.status, 403);
    assert_eq!(call(&w.bridge, "POST", url, &[("x-eos-ui-token", "wrong")], b"null").await.status, 403);
    assert!(w.host.calls.lock().unwrap().is_empty());
    assert_eq!(call(&w.bridge, "POST", url, &[("x-eos-ui-token", TOKEN)], b"null").await.status, 200);
    assert_eq!(*w.host.calls.lock().unwrap(), vec!["drag".to_string()]);
    assert_eq!(call(&w.bridge, "GET", url, &[("x-eos-ui-token", TOKEN)], b"").await.status, 405);
    assert_eq!(bridge_call(&w, "no/such", Value::Null).await.status, 404);
    assert_eq!(w.bridge.status()["requests"]["refused"], 4);
}

#[tokio::test]
async fn the_event_stream_needs_the_token_in_its_query() {
    let w = world();
    assert_eq!(call(&w.bridge, "GET", "http://eos.localhost/_shell/events", &[], b"").await.status, 403);
    assert_eq!(call(&w.bridge, "GET", "http://eos.localhost/_shell/events?t=nope", &[], b"").await.status, 403);
    assert_eq!(w.bridge.events().subscribers(), 0);
}

#[tokio::test]
async fn media_loads_of_the_dashboard_get_the_token_added() {
    let w = world();
    let media = "http://eos.localhost/_core/api/genui/media/img?u=x";
    call_from(&w.bridge, Initiator::Document, "GET", media, &[], b"").await;
    call_from(&w.bridge, Initiator::Frame, "GET", media, &[], b"").await;
    call_from(&w.bridge, Initiator::Document, "GET", "http://eos.localhost/_core/api/settings", &[], b"").await;
    let seen = w.core.seen.lock().unwrap();
    assert_eq!(seen[0].1.header("x-eos-ui-token"), Some(TOKEN));
    assert_eq!(seen[1].1.header("x-eos-ui-token"), None, "a sandboxed frame");
    assert_eq!(seen[2].1.header("x-eos-ui-token"), None, "another route");
}

// ---- streams ---------------------------------------------------------------------

#[tokio::test]
async fn an_event_stream_delivers_and_is_dropped_when_the_page_closes_it() {
    let w = world();
    let (sink, body) = channel();
    w.bridge.call(
        Req {
            initiator: Initiator::Document,
            method: "GET".into(),
            url: format!("http://eos.localhost/_shell/events?t={TOKEN}"),
            ..Default::default()
        },
        sink,
    );
    assert_eq!(w.bridge.events().subscribers(), 1);
    w.bridge.fullscreen_changed(true);
    w.bridge.edit(EditCommand::Paste);
    let mut buf = [0u8; 4096];
    let Read::Data(n) = body.read(&mut buf, || {}) else { panic!("frames expected") };
    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
    assert!(text.contains(r#"{"name":"window:fullscreen","payload":{"on":true}}"#), "{text}");
    assert!(text.contains(r#"{"name":"edit","payload":{"command":"paste"}}"#), "{text}");
    // The page closes its EventSource: the shell's handler cancels the body.
    body.cancel();
    w.bridge.fullscreen_changed(false);
    assert_eq!(w.bridge.events().subscribers(), 0);
}

// ---- bridges ---------------------------------------------------------------------

#[tokio::test]
async fn the_element_picker_answers_the_picked_element_or_nothing() {
    struct Picks(AtomicBool);
    impl ElementPicker for Picks {
        fn pick<'a>(&'a self, tab_id: &'a str) -> BoxFuture<'a, Option<eos_contracts::BrowserElement>> {
            let element = (tab_id == "tab-1").then(|| eos_contracts::BrowserElement {
                r#ref: "@e3".into(),
                tag: "button".into(),
                role: "button".into(),
                name: "Go".into(),
                r#box: (10.into(), 20.into(), 100.into(), 40.into()),
                focusable: true,
                state: None,
                value: None,
                locator: "role=button[name=\"Go\"]".into(),
            });
            Box::pin(async move { element })
        }
        fn cancel(&self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }
    let w = world();
    // Before the core is up there is nothing to pick with.
    assert_eq!(bridge_call(&w, "browserView/pick", json!({ "tabId": "tab-1" })).await.json()["value"], Value::Null);
    let picks = Arc::new(Picks(AtomicBool::new(false)));
    w.bridge.set_element_picker(picks.clone());
    let picked = bridge_call(&w, "browserView/pick", json!({ "tabId": "tab-1" })).await.json();
    assert_eq!(
        picked["value"],
        json!({ "ref": "@e3", "tag": "button", "role": "button", "name": "Go", "box": [10, 20, 100, 40], "focusable": true, "locator": "role=button[name=\"Go\"]" })
    );
    assert_eq!(bridge_call(&w, "browserView/pick", json!({ "tabId": "other" })).await.json()["value"], Value::Null);
    bridge_call(&w, "browserView/pickCancel", Value::Null).await;
    assert!(picks.0.load(Ordering::SeqCst));
}

#[tokio::test]
async fn stale_geometry_is_dropped_and_the_view_lands_on_the_newest() {
    let w = world();
    bridge_call(&w, "browserView/setActiveView", json!({ "seq": 100, "sessionKey": "s", "tabId": "tab-1" })).await;
    for (seq, x) in [(103, 30.0), (102, 20.0), (101, 10.0)] {
        bridge_call(&w, "browserView/setBounds", json!({ "seq": seq, "x": x, "y": 50, "width": 400, "height": 300 }))
            .await;
    }
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(w.views.calls.lock().unwrap().last().map(String::as_str), Some("place tab-1 30,50 400x300"));
    let status = w.bridge.status();
    assert_eq!(status["panel"]["dropped"], 2);
    assert_eq!(status["panel"]["shown"], true);
    assert_eq!(status["panel"]["view"], "tab-1");

    // An overlay opens and closes; the reports cross on the way.
    bridge_call(&w, "browserView/overlay", json!({ "seq": 111, "value": false })).await;
    bridge_call(&w, "browserView/overlay", json!({ "seq": 110, "value": true })).await;
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert_eq!(w.bridge.status()["panel"]["shown"], true, "the stale 'open' must not hide the view");

    let still = bridge_call(&w, "browserView/snapshot", Value::Null).await.json();
    assert_eq!(still["value"]["url"], "data:image/jpeg;base64,dGFiLTE=");
    assert_eq!(still["value"]["rect"]["width"], 400.0);
    assert_eq!(bridge_call(&w, "browserView/setBounds", json!({ "x": 1 })).await.status, 400);
}

#[tokio::test]
async fn a_banner_shows_only_while_the_user_is_elsewhere() {
    let w = world();
    let note = json!({ "title": "Input needed", "body": "Pick one", "workerId": "w-1", "route": "" });
    assert_eq!(w.bridge.notify(&note), Notified::Shown);
    assert_eq!(
        w.host.banners.lock().unwrap()[0],
        Banner {
            title: "Input needed".into(),
            body: "Pick one".into(),
            target: Some(BannerTarget::Worker("w-1".into())),
            host: None,
        }
    );
    w.host.focused.store(true, Ordering::SeqCst);
    assert_eq!(w.bridge.notify(&note), Notified::Suppressed);
    assert_eq!(w.bridge.notify(&json!({ "title": "no body" })), Notified::Invalid);
    assert_eq!(w.host.banners.lock().unwrap().len(), 1);
    // The dashboard's own warnings take the same path.
    w.host.focused.store(false, Ordering::SeqCst);
    let a = bridge_call(&w, "notify", json!({ "title": "Sync failed", "body": "Offline" })).await;
    assert_eq!(a.json()["value"], true);
    assert_eq!(w.host.banners.lock().unwrap()[1].target, None);
}

#[tokio::test]
async fn a_route_wins_over_a_worker_and_a_click_reaches_the_page() {
    let w = world();
    w.bridge.notify(&json!({ "title": "Memory", "body": "3 suggestions", "workerId": "w-1", "route": "memory" }));
    let target = w.host.banners.lock().unwrap()[0].target.clone().unwrap();
    assert_eq!(target, BannerTarget::Route("memory".into()));
    let (sink, body) = channel();
    w.bridge.events().subscribe(sink);
    w.bridge.banner_clicked(Some(&target), None);
    w.bridge.banner_clicked(Some(&BannerTarget::Worker("w-9".into())), None);
    let mut buf = [0u8; 1024];
    let Read::Data(n) = body.read(&mut buf, || {}) else { panic!("frames expected") };
    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
    assert!(text.contains(r#"{"name":"navigate","payload":{"route":"memory"}}"#), "{text}");
    assert!(text.contains(r#"{"name":"navigate","payload":{"workerId":"w-9"}}"#), "{text}");
}

#[tokio::test]
async fn a_link_that_launched_the_app_reaches_the_page_once_it_listens() {
    let w = world();
    w.bridge.hosts_command("connect", Some("eos://pair/abc"));
    w.bridge.edit(EditCommand::Paste);
    let (sink, body) = channel();
    w.bridge.events().subscribe(sink);
    let mut buf = [0u8; 1024];
    let Read::Data(n) = body.read(&mut buf, || {}) else { panic!("frames expected") };
    let text = String::from_utf8_lossy(&buf[..n]).into_owned();
    assert!(
        text.contains(r#"{"name":"hosts:command","payload":{"type":"connect","invite":"eos://pair/abc"}}"#),
        "{text}"
    );
    assert!(!text.contains("paste"), "an Edit command from before the page listened must not run later");
}

/// Knows one surface issue; everything else goes to the fake core.
struct IssueCore(Arc<FakeCore>);

impl Core for IssueCore {
    fn ui_token(&self) -> String {
        TOKEN.to_string()
    }

    fn call(&self, plane: Plane, req: Req, sink: Sink) {
        if req.url == "/api/surface-issues/si-41" {
            let row = json!({ "id": "si-41", "surfaceId": "sf-3", "seq": 41, "kind": "page" });
            sink.respond(200, vec![("content-type".into(), "application/json".into())], row.to_string().as_bytes());
        } else {
            self.0.call(plane, req, sink);
        }
    }
}

#[tokio::test]
async fn links_open_their_place_and_an_issue_link_finds_its_page_first() {
    let w = world_over(None, |core| Arc::new(IssueCore(core)));
    assert_eq!(
        w.bridge.open_link("eos://run/pr-review?item=482"),
        crate::links::Link::Open("eos:/form?routine=pr-review&item=482&from=link".into())
    );
    w.bridge.open_link("eos://issue/si-41?button=ask&index=2");
    assert_eq!(w.bridge.open_link("eos://run/pr-review?go=now"), crate::links::Link::Window);
    let mut text = String::new();
    for _ in 0..100 {
        if text.contains("sf-3") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        let (sink, body) = channel();
        w.bridge.events().subscribe(sink);
        let mut buf = [0u8; 4096];
        if let Read::Data(n) = body.read(&mut buf, || {}) {
            text.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
    }
    assert!(
        text.contains(r#"{"name":"navigate","payload":{"route":"eos:/form?routine=pr-review&item=482&from=link"}}"#),
        "{text}"
    );
    assert!(
        text.contains(r#"{"name":"navigate","payload":{"route":"eos:/surfaces/sf-3?issue=41&button=ask&index=2"}}"#),
        "{text}"
    );
    assert_eq!(text.matches("navigate").count(), 2, "a link outside the grammar navigates nowhere: {text}");
}

#[tokio::test]
async fn the_theme_is_kept_for_the_next_launch() {
    let w = world();
    assert_eq!(Bridge::persisted_theme(&w.data), Theme::Dark);
    bridge_call(&w, "theme/changed", json!({ "theme": "light" })).await;
    assert_eq!(Bridge::persisted_theme(&w.data), Theme::Light);
    assert_eq!(*w.host.calls.lock().unwrap(), vec!["theme light".to_string()]);
    let snap = bridge_call(&w, "theme/snapshot", Value::Null).await.json();
    assert_eq!(snap["value"], "data:image/jpeg;base64,ZGFzaA==");
}

#[tokio::test]
async fn a_saved_file_stays_in_downloads() {
    let w = world();
    let a = bridge_call(&w, "files/save", json!({ "filename": "../../etc/evil:name.txt", "base64": "aGVsbG8=" })).await;
    assert_eq!(a.status, 200);
    let saved = w.host.downloads_dir().join("evil_name.txt");
    assert_eq!(std::fs::read(saved).unwrap(), b"hello");
    assert_eq!(*w.host.calls.lock().unwrap(), vec!["open evil_name.txt".to_string()]);
    assert_eq!(a.json()["value"], true);
    assert_eq!(bridge_call(&w, "files/save", json!({ "filename": "a", "base64": "***" })).await.status, 400);

    // A Downloads folder that cannot take it: the page hears so, and nothing is opened.
    *w.host.downloads.lock().unwrap() = w.host.downloads_dir().join("missing");
    let failed = bridge_call(&w, "files/save", json!({ "filename": "b.txt", "base64": "aGVsbG8=" })).await;
    assert_eq!(failed.status, 500);
    assert_eq!(failed.json()["error"], "The file could not be saved in Downloads.");
    assert_eq!(w.host.calls.lock().unwrap().len(), 1, "only the first file was opened");
    assert_eq!(sanitize_filename(""), "download");
    assert_eq!(sanitize_filename(".."), "download");
    assert_eq!(sanitize_filename("C:\\Users\\me\\report.pdf"), "report.pdf");
}

#[tokio::test]
async fn pasted_and_dropped_files_come_back_as_entries() {
    let w = world();
    let pasted = bridge_call(&w, "clipboard/paths", Value::Null).await.json();
    let list = pasted["value"].as_array().unwrap();
    assert_eq!(list.len(), 2, "empty paths are left out");
    assert_eq!(list[0]["isDir"], true);
    assert_eq!(list[1], json!({ "path": "/no/such/file.txt", "isDir": false }));
    let dropped = bridge_call(&w, "files/dropped", Value::Null).await.json();
    assert_eq!(dropped["value"], json!([{ "path": "/no/such/dropped.png", "isDir": false }]));
    let clip = bridge_call(&w, "clipboard/read", Value::Null).await.json();
    assert_eq!(clip["value"], json!({ "text": "clip", "hasFiles": false }));
}

#[tokio::test]
async fn edit_commands_and_the_clipboard_reach_the_host() {
    let w = world();
    bridge_call(&w, "edit", json!({ "command": "selectAll" })).await;
    bridge_call(&w, "clipboard/write", json!({ "text": "selection" })).await;
    bridge_call(&w, "window/toggleZoom", Value::Null).await;
    assert_eq!(bridge_call(&w, "edit", json!({ "command": "explode" })).await.status, 400);
    assert_eq!(
        *w.host.calls.lock().unwrap(),
        vec!["edit selectAll".to_string(), "copy selection".to_string(), "zoom".to_string()]
    );
}

#[tokio::test]
async fn the_carry_over_is_offered_until_the_page_confirms() {
    let seed = Seed { keys: [("cm:theme".to_string(), "ışık".to_string())].into(), undecodable: 0 };
    let w = world_with(Some(seed));
    let doc = || call_from(&w.bridge, Initiator::TopLevel, "GET", "http://eos.localhost/", &[], b"");
    assert!(doc().await.text().contains(r#""seed":{"cm:theme":"\u0131\u015f\u0131k"}"#));
    assert!(!Marker::new(&w.data).exists());
    bridge_call(&w, "migration/done", json!({ "keys": 1 })).await;
    assert!(Marker::new(&w.data).exists());
    assert!(doc().await.text().contains(r#""seed":null"#), "a reload after the carry-over offers nothing");
}

#[tokio::test]
async fn ready_is_recorded_once() {
    let w = world();
    assert_eq!(w.bridge.status()["ready"], false);
    bridge_call(&w, "ready", json!({ "ms": 180 })).await;
    bridge_call(&w, "ready", json!({ "ms": 999 })).await;
    let status = w.bridge.status();
    assert_eq!(status["ready"], true);
    assert_eq!(status["readyInPageMs"], 180);
}

#[tokio::test]
async fn the_machine_list_is_empty_for_now() {
    let w = world();
    assert_eq!(
        bridge_call(&w, "hosts/list", Value::Null).await.json()["value"],
        json!({ "hosts": [], "active": null, "local": null })
    );
}

#[test]
fn a_browser_download_lands_in_downloads_without_replacing_a_file() {
    let dir = Dir::new("browser-download");
    let downloads = dir.path();
    assert_eq!(download_destination(downloads, "report.pdf"), downloads.join("report.pdf"));
    std::fs::write(downloads.join("report.pdf"), b"mine").unwrap();
    assert_eq!(download_destination(downloads, "report.pdf"), downloads.join("report (1).pdf"));
    std::fs::write(downloads.join("report (1).pdf"), b"mine too").unwrap();
    assert_eq!(download_destination(downloads, "report.pdf"), downloads.join("report (2).pdf"));
    // The page's name never leaves the folder; no name at all is "download".
    assert_eq!(download_destination(downloads, "../../etc/passwd"), downloads.join("passwd"));
    assert_eq!(download_destination(downloads, ""), downloads.join("download"));
    std::fs::write(downloads.join(".env"), b"x").unwrap();
    assert_eq!(download_destination(downloads, ".env"), downloads.join(".env (1)"));
}

// ---- Start at login ------------------------------------------------------------------

async fn login_item(w: &World, method: &str, body: &[u8]) -> Answer {
    let url = "http://eos.localhost/_shell/doors/login-item";
    call(&w.bridge, method, url, &[("x-eos-ui-token", TOKEN)], body).await
}

#[tokio::test(flavor = "multi_thread")]
async fn the_login_item_is_read_each_time_and_never_registered_unasked() {
    let w = world();
    let a = login_item(&w, "GET", b"").await;
    assert_eq!(a.status, 200);
    assert_eq!(a.json(), json!({ "available": true, "state": "off", "offered": false }));
    // The user turned it on in System Settings: the next read says so.
    *w.host.login.lock().unwrap() = Some(LoginItem::On);
    assert_eq!(login_item(&w, "GET", b"").await.json()["state"], "on");
    assert!(w.host.calls.lock().unwrap().is_empty(), "reading never registers");
    assert!(!w.data.join("doors.json").exists(), "reading makes no offer");
}

#[tokio::test(flavor = "multi_thread")]
async fn turning_it_on_waits_for_approval_in_system_settings_and_the_offer_is_made_once() {
    let w = world();
    let a = login_item(&w, "PUT", br#"{"on":true}"#).await;
    assert_eq!(a.json(), json!({ "available": true, "state": "needs-approval", "offered": true }));
    assert_eq!(*w.host.calls.lock().unwrap(), ["login true", "login settings"]);
    let doors: Value = serde_json::from_slice(&std::fs::read(w.data.join("doors.json")).unwrap()).unwrap();
    assert_eq!(doors, json!({ "loginOffered": true }));

    let off = login_item(&w, "PUT", br#"{"on":false}"#).await;
    assert_eq!(off.json(), json!({ "available": true, "state": "off", "offered": true }));
    assert_eq!(w.host.calls.lock().unwrap().last().map(String::as_str), Some("login false"));
    assert_eq!(login_item(&w, "GET", b"").await.json()["state"], "off", "it stays off");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_login_item_nothing_is_registered() {
    let w = world();
    *w.host.login.lock().unwrap() = Some(LoginItem::Unavailable);
    let a = login_item(&w, "PUT", br#"{"on":true}"#).await;
    assert_eq!(a.json(), json!({ "available": false, "state": "off", "offered": true }));
    assert!(w.host.calls.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_login_item_takes_the_dashboards_token_and_a_choice() {
    let w = world();
    let url = "http://eos.localhost/_shell/doors/login-item";
    assert_eq!(call(&w.bridge, "GET", url, &[], b"").await.status, 403);
    assert_eq!(call(&w.bridge, "PUT", url, &[("x-eos-ui-token", "wrong")], br#"{"on":true}"#).await.status, 403);
    assert_eq!(login_item(&w, "PUT", br#"{"on":"yes"}"#).await.status, 400);
    assert_eq!(login_item(&w, "DELETE", b"").await.status, 405);
    assert!(w.host.calls.lock().unwrap().is_empty());
}
