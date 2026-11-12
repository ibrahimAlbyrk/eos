//! The machine switcher and a host's door, against a core and a window that record what
//! they are asked (`app/src/main/hosts.ts`, `transfers.ts` behaviour).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use eos_core::BoxFuture;

use super::*;
use crate::ask::collect;
use crate::host::{Banner, EditCommand, Theme};
use crate::testdir::Dir;
use crate::transport::{Initiator, Req, Sink, channel};

const H: &str = "h1";

/// A request the core got: plane, method, target, token.
type Seen = (Plane, String, String, Option<String>);

struct FakeCore {
    host_stamp: &'static str,
    seen: Mutex<Vec<Seen>>,
}

impl FakeCore {
    fn seen(&self) -> Vec<Seen> {
        std::mem::take(&mut *self.seen.lock().unwrap())
    }
}

impl Core for FakeCore {
    fn ui_token(&self) -> String {
        "ui".into()
    }

    fn call(&self, plane: Plane, req: Req, sink: Sink) {
        let token = req.header("x-eos-ui-token").map(str::to_owned);
        self.seen.lock().unwrap().push((plane, req.method.clone(), req.url.clone(), token));
        let body: Value = serde_json::from_slice(&req.body).unwrap_or(Value::Null);
        let (status, answer): (u16, Value) = match (req.method.as_str(), req.url.as_str()) {
            ("GET", "/api/host") => {
                (200, json!({ "name": "This Mac", "platform": "darwin", "deviceId": "dev-1", "apiStamp": "stamp-1" }))
            }
            ("GET", "/api/hosts") => (
                200,
                json!({ "hosts": [{
                    "id": H, "name": "Studio", "alias": null, "deviceId": "dev-2", "platform": "darwin",
                    "link": { "state": "live" }, "info": { "servesUi": true, "apiStamp": self.host_stamp, "home": "/Users/s", "name": "Studio" },
                }] }),
            ),
            ("POST", "/api/hosts/h1/view-token") => (200, json!({ "token": "view-h1" })),
            ("GET", "/h/h1/ui/index.html") => {
                return sink.respond(
                    200,
                    vec![("content-type".into(), "text/html".into())],
                    b"<html><head></head><body>the host's</body></html>",
                );
            }
            ("GET", "/api/transfers") => (
                200,
                json!({ "transfers": [
                    { "id": "t1", "from": H, "to": "local", "placed": [{ "name": "a", "path": "/Users/me/Downloads/Eos/a" }] },
                    { "id": "t2", "from": "local", "to": "h9", "placed": [] },
                ] }),
            ),
            ("POST", url) if url.starts_with("/api/transfers") => (200, json!({ "asked": url, "body": body })),
            _ => (200, json!({ "ok": true })),
        };
        sink.respond(status, vec![("content-type".into(), "application/json".into())], answer.to_string().as_bytes());
    }
}

#[derive(Default)]
struct FakeSurface {
    calls: Mutex<Vec<String>>,
}

impl FakeSurface {
    fn take(&self) -> Vec<String> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
    fn record(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }
}

impl HostSurface for FakeSurface {
    fn create(&self, id: &str, _service: Arc<dyn Service>) -> BoxFuture<'_, Result<(), String>> {
        self.record(format!("create {id}"));
        Box::pin(async { Ok(()) })
    }
    fn show(&self, id: &str) -> BoxFuture<'_, ()> {
        self.record(format!("show {id}"));
        Box::pin(async {})
    }
    fn hide(&self, id: &str) -> BoxFuture<'_, ()> {
        self.record(format!("hide {id}"));
        Box::pin(async {})
    }
    fn close(&self, id: &str) -> BoxFuture<'_, ()> {
        self.record(format!("close {id}"));
        Box::pin(async {})
    }
    fn open_window(&self, _id: &str, label: &str, title: &str, _service: Arc<dyn Service>) -> BoxFuture<'_, ()> {
        self.record(format!("window {label} {title}"));
        Box::pin(async {})
    }
    fn focus_dashboard(&self) {
        self.record("focus dashboard".into());
    }
    fn pick(&self, folders_only: bool) -> BoxFuture<'_, Option<Vec<String>>> {
        self.record(format!("pick {folders_only}"));
        Box::pin(async { Some(vec!["/Users/me/picked".to_owned()]) })
    }
    fn reveal(&self, path: &str) {
        self.record(format!("reveal {path}"));
    }
}

/// The window, with its Downloads folder in the test's own folder.
struct Window(PathBuf);

impl ShellHost for Window {
    fn start_window_drag(&self) {}
    fn toggle_window_zoom(&self) {}
    fn window_focused(&self) -> bool {
        false
    }
    fn set_theme(&self, _theme: Theme) {}
    fn show_banner(&self, _banner: Banner) {}
    fn clipboard_text(&self) -> Option<String> {
        None
    }
    fn set_clipboard_text(&self, _text: &str) {}
    fn clipboard_file_paths(&self) -> Vec<String> {
        Vec::new()
    }
    fn clipboard_has_files(&self) -> bool {
        false
    }
    fn dropped_file_paths(&self) -> Vec<String> {
        Vec::new()
    }
    fn edit(&self, _command: EditCommand) {}
    fn open_path(&self, _path: &Path) {}
    fn downloads_dir(&self) -> PathBuf {
        self.0.clone()
    }
}

struct Bench {
    hosts: HostViews,
    core: Arc<FakeCore>,
    surface: Arc<FakeSurface>,
    dashboard: Arc<Mutex<Vec<(String, Value)>>>,
    covered: Arc<Mutex<Vec<bool>>>,
    snapshots: Arc<Mutex<Vec<Value>>>,
    _dir: Dir,
}

fn bench(host_stamp: &'static str) -> Bench {
    let dir = Dir::new("host-views");
    std::fs::create_dir_all(dir.path().join("dist/assets")).unwrap();
    std::fs::write(dir.path().join("dist/index.html"), "<html><head></head><body>ours</body></html>").unwrap();
    std::fs::write(dir.path().join("dist/assets/app.js"), "ours.js").unwrap();
    let core = Arc::new(FakeCore { host_stamp, seen: Mutex::default() });
    let surface = Arc::new(FakeSurface::default());
    let dashboard: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let covered: Arc<Mutex<Vec<bool>>> = Arc::default();
    let snapshots: Arc<Mutex<Vec<Value>>> = Arc::default();
    let (to_dashboard, cover, seen) = (dashboard.clone(), covered.clone(), snapshots.clone());
    let hosts = HostViews::new(HostParts {
        core: core.clone(),
        surface: surface.clone(),
        dist: dir.path().join("dist"),
        shell: Arc::new(Window(dir.path().join("Downloads"))),
        to_dashboard: Arc::new(move |name, payload| to_dashboard.lock().unwrap().push((name.to_owned(), payload))),
        changed: Arc::new(move |snapshot| {
            cover.lock().unwrap().push(!snapshot["active"].is_null());
            seen.lock().unwrap().push(snapshot.clone());
        }),
        rt: tokio::runtime::Handle::current(),
    });
    Bench { hosts, core, surface, dashboard, covered, snapshots, _dir: dir }
}

fn req(initiator: Initiator, method: &str, url: &str, token: Option<&str>, body: Value) -> Req {
    let mut headers = vec![("content-type".to_owned(), "application/json".to_owned())];
    if let Some(token) = token {
        headers.push(("x-eos-ui-token".to_owned(), token.to_owned()));
    }
    Req { initiator, method: method.into(), url: url.into(), headers, body: body.to_string().into_bytes() }
}

/// Sends `req` through the view's door; status, headers and body.
async fn through(view: &Arc<HostViewService>, req: Req) -> (u16, Vec<(String, String)>, String) {
    let (sink, body) = channel();
    view.call(req, sink);
    let (head, bytes) = collect(&body, 1 << 20).await.unwrap();
    (head.status, head.headers, String::from_utf8_lossy(&bytes).into_owned())
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
}

impl Bench {
    async fn view(&self) -> Arc<HostViewService> {
        self.hosts.refresh().await;
        self.hosts.switch_to(Some(H.into())).await;
        self.hosts.inner.state().views.get(H).cloned().unwrap()
    }
}

#[tokio::test]
async fn the_list_names_this_computer_and_its_hosts_and_every_page_hears_of_changes() {
    let b = bench("stamp-1");
    assert_eq!(b.hosts.snapshot(), json!({ "hosts": [], "active": null, "local": null }));
    b.hosts.refresh().await;
    let snap = b.hosts.snapshot();
    assert_eq!(snap["local"], json!({ "name": "This Mac", "platform": "darwin", "deviceId": "dev-1" }));
    assert_eq!(snap["hosts"][0]["id"], H);
    assert_eq!(b.dashboard.lock().unwrap().last().unwrap().0, "hosts:changed");
    assert_eq!(*b.covered.lock().unwrap(), [false]);
    assert_eq!(b.snapshots.lock().unwrap().last(), Some(&snap));
}

#[tokio::test]
async fn switching_shows_one_live_view_per_host_and_back() {
    let b = bench("stamp-1");
    b.hosts.switch_to(Some(H.into())).await;
    assert!(b.surface.take().is_empty(), "an unknown host is not switched to");
    let view = b.view().await;
    assert_eq!(b.surface.take(), ["create h1", "show h1"]);
    assert_eq!(b.hosts.active().as_deref(), Some(H));
    assert_eq!(b.covered.lock().unwrap().last(), Some(&true));
    assert_eq!(view.host_id(), H);
    b.hosts.switch_to(None).await;
    b.hosts.switch_to(Some(H.into())).await;
    assert_eq!(b.surface.take(), ["hide h1", "focus dashboard", "show h1"], "the view is kept, not rebuilt");
    b.hosts.request_connect().await;
    assert_eq!(
        b.dashboard.lock().unwrap().last().unwrap(),
        &("hosts:command".to_owned(), json!({ "type": "connect", "invite": null }))
    );
    b.hosts.open_in_window(H.into()).await;
    assert_eq!(b.surface.take(), ["hide h1", "focus dashboard", "window hostwin-0 Eos — Studio"]);
}

#[tokio::test]
async fn a_window_of_its_own_drops_its_door_when_it_closes() {
    let b = bench("stamp-1");
    b.hosts.refresh().await;
    b.hosts.open_in_window(H.into()).await;
    b.hosts.open_in_window(H.into()).await;
    let doors = || b.hosts.inner.state().windows.iter().map(|(n, _, _)| *n).collect::<Vec<_>>();
    assert_eq!(doors(), [0, 1]);
    assert_eq!(b.hosts.inner.pages(Some(H)).len(), 2);
    b.hosts.window_closed("hostwin-0");
    b.hosts.window_closed("main");
    b.hosts.window_closed("hostwin-x");
    assert_eq!(doors(), [1], "only the closed window's door goes");
    b.hosts.window_closed(&window_label(1));
    assert!(doors().is_empty());
    assert!(b.hosts.inner.pages(None).is_empty());
    assert_eq!(window_number("hostwin-7"), Some(7));
    assert_eq!(window_number("hostwin-"), None);
}

#[tokio::test]
async fn a_host_on_our_api_runs_our_dashboard_pinned_to_its_prefix() {
    let b = bench("stamp-1");
    let view = b.view().await;
    let (status, headers, html) =
        through(&view, req(Initiator::TopLevel, "GET", "http://eos.localhost/index.html", None, Value::Null)).await;
    assert_eq!(status, 200);
    assert!(html.contains("ours") && html.contains("\"uiToken\":\"view-h1\""), "{html}");
    assert!(
        html.contains("\"coreUrl\":\"http://eos.localhost/_core/h/h1\"")
            && html.contains("\"rawUrl\":\"http://raw.eos.localhost/h/h1\"")
    );
    assert!(
        html.contains(
            "\"host\":{\"id\":\"h1\",\"remote\":true,\"name\":\"Studio\",\"deviceId\":\"dev-2\",\"home\":\"/Users/s\"}"
        ),
        "{html}"
    );
    let policy = header(&headers, "content-security-policy").unwrap();
    assert!(policy.contains("connect-src http://eos.localhost/_core/h/h1/ http://eos.localhost/_shell/"), "{policy}");
    assert!(policy.contains("frame-src http://raw.eos.localhost/h/h1/"), "{policy}");
    assert!(view.trusted());
    // A frame showing the entry document gets it without the script.
    let (_, _, framed) =
        through(&view, req(Initiator::Frame, "GET", "http://eos.localhost/index.html", None, Value::Null)).await;
    assert!(!framed.contains("uiToken"));
}

#[tokio::test]
async fn a_host_on_another_api_runs_its_own_bundle_and_gets_no_transfers() {
    let b = bench("stamp-2");
    let view = b.view().await;
    b.core.seen();
    let (status, headers, html) =
        through(&view, req(Initiator::TopLevel, "GET", "http://eos.localhost/", None, Value::Null)).await;
    assert_eq!(status, 200);
    assert!(html.contains("the host's") && html.contains("\"uiToken\":\"view-h1\""), "{html}");
    assert!(header(&headers, "content-security-policy").is_some_and(|p| p.contains("/_core/h/h1/")));
    assert!(!view.trusted());
    // A fingerprinted asset this computer has is the same file; anything else is the host's.
    let (_, _, js) =
        through(&view, req(Initiator::Document, "GET", "http://eos.localhost/assets/app.js", None, Value::Null)).await;
    assert_eq!(js, "ours.js");
    through(&view, req(Initiator::Document, "GET", "http://eos.localhost/sw.js", None, Value::Null)).await;
    let asked: Vec<_> = b.core.seen().into_iter().map(|(_, m, u, t)| (m, u, t)).collect();
    assert_eq!(
        asked,
        [
            ("GET".into(), "/h/h1/ui/index.html".into(), Some("view-h1".into())),
            ("GET".into(), "/h/h1/ui/sw.js".into(), Some("view-h1".into()))
        ]
    );
    let refused =
        req(Initiator::Document, "POST", "http://eos.localhost/_shell/transfer/list", Some("view-h1"), json!({}));
    let (_, _, answer) = through(&view, refused).await;
    let answer: Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(answer["code"], "needs-update");
}

#[tokio::test]
async fn the_view_reaches_its_host_only_and_always_as_that_hosts_view() {
    let b = bench("stamp-1");
    let view = b.view().await;
    b.core.seen();
    let own = req(Initiator::Document, "GET", "http://eos.localhost/_core/h/h1/workers?x=1", Some("ui"), Value::Null);
    assert_eq!(through(&view, own).await.0, 200);
    let raw = req(Initiator::Frame, "GET", "http://raw.eos.localhost/h/h1/fs/raw?path=/a", None, Value::Null);
    assert_eq!(through(&view, raw).await.0, 200);
    let asked = b.core.seen();
    assert_eq!(
        asked,
        [
            (Plane::Api, "GET".into(), "/h/h1/workers?x=1".into(), Some("view-h1".into())),
            (Plane::Raw, "GET".into(), "/h/h1/fs/raw?path=/a".into(), Some("view-h1".into()))
        ],
        "the dashboard's token a page sends is replaced by the view's"
    );
    for url in [
        "http://eos.localhost/_core/workers",
        "http://eos.localhost/_core/h/h2/workers",
        "http://eos.localhost/_core/h/h1/../workers",
        "http://eos.localhost/_core/h/h1x/workers",
        "http://raw.eos.localhost/fs/raw?path=/etc/passwd",
    ] {
        assert_eq!(through(&view, req(Initiator::Document, "GET", url, None, Value::Null)).await.0, 403, "{url}");
    }
    assert!(b.core.seen().is_empty());
}

#[tokio::test]
async fn the_switcher_and_transfers_answer_the_views_own_document_only() {
    let b = bench("stamp-1");
    let view = b.view().await;
    let post = |path: &str, token: Option<&str>, initiator: Initiator, body: Value| {
        req(initiator, "POST", &format!("http://eos.localhost/_shell/{path}"), token, body)
    };
    assert_eq!(through(&view, post("hosts/list", None, Initiator::Document, json!({}))).await.0, 403);
    assert_eq!(through(&view, post("hosts/list", Some("ui"), Initiator::Document, json!({}))).await.0, 403);
    assert_eq!(through(&view, post("hosts/list", Some("view-h1"), Initiator::Frame, json!({}))).await.0, 403);
    let (status, _, list) = through(&view, post("hosts/list", Some("view-h1"), Initiator::Document, json!({}))).await;
    assert_eq!(status, 200);
    assert_eq!(serde_json::from_str::<Value>(&list).unwrap()["value"]["active"], H);
    assert_eq!(through(&view, post("artifacts/warm", Some("view-h1"), Initiator::Document, json!({}))).await.0, 404);

    let call = |verb: &str, body: Value| post(&format!("transfer/{verb}"), Some("view-h1"), Initiator::Document, body);
    let value = |text: String| serde_json::from_str::<Value>(&text).unwrap();
    let listed = value(through(&view, call("list", json!({}))).await.2);
    assert_eq!(listed["value"].as_array().unwrap().len(), 1, "only transfers with this host");
    let pulled = value(through(&view, call("pull", json!({ "paths": ["/Users/s/a"], "chosen": false }))).await.2);
    assert_eq!(pulled["value"]["body"], json!({ "from": H, "to": "local", "paths": ["/Users/s/a"], "destDir": null }));
    let chosen = value(through(&view, call("chooseFolder", json!({}))).await.2);
    assert_eq!(chosen["value"], json!({ "destDir": "/Users/me/picked" }));
    let pulled = value(through(&view, call("pull", json!({ "paths": ["/Users/s/a"], "chosen": true }))).await.2);
    assert_eq!(pulled["value"]["body"]["destDir"], "/Users/me/picked");
    let pushed = value(through(&view, call("push", json!({ "destDir": "relative" }))).await.2);
    assert_eq!(
        pushed["value"]["body"],
        json!({ "from": "local", "to": H, "paths": ["/Users/me/picked"], "destDir": null })
    );
    let other = value(through(&view, call("act", json!({ "id": "t2", "action": "cancel" }))).await.2);
    assert_eq!(other["error"], "not a transfer with this computer");
    let decided = value(
        through(&view, call("act", json!({ "id": "t1", "action": "decide", "decisions": { "a": "skip" } }))).await.2,
    );
    assert_eq!(decided["value"]["asked"], "/api/transfers/t1/decide");
    assert_eq!(decided["value"]["body"], json!({ "decisions": { "a": "skip" } }));
    let bad = value(through(&view, call("act", json!({ "id": "t1", "action": "delete" }))).await.2);
    assert_eq!(bad["error"], "unknown action");
    through(&view, call("reveal", json!({ "id": "t1" }))).await;
    assert!(b.surface.take().contains(&"reveal /Users/me/Downloads/Eos/a".to_owned()));
    let token_of =
        b.core.seen().into_iter().filter(|(_, _, u, _)| u.starts_with("/api/transfers")).map(|(_, _, _, t)| t);
    assert!(
        token_of.into_iter().all(|t| t.as_deref() == Some("ui")),
        "this computer's engine is asked as its dashboard"
    );
}

#[tokio::test]
async fn only_a_view_running_our_dashboard_saves_into_downloads() {
    for (stamp, saves) in [("stamp-1", true), ("stamp-2", false)] {
        let b = bench(stamp);
        let view = b.view().await;
        through(&view, req(Initiator::TopLevel, "GET", "http://eos.localhost/index.html", None, Value::Null)).await;
        std::fs::create_dir_all(b._dir.path().join("Downloads")).unwrap();
        let save = json!({ "filename": "../notes.md", "base64": "aGk=" });
        let asked = req(Initiator::Document, "POST", "http://eos.localhost/_shell/files/save", Some("view-h1"), save);
        let answer: Value = serde_json::from_str(&through(&view, asked).await.2).unwrap();
        let saved = b._dir.path().join("Downloads/notes.md");
        assert_eq!(saved.is_file(), saves, "{stamp}: {answer}");
        assert_eq!(answer.get("code").is_some(), !saves);
    }
}

#[tokio::test]
async fn transfer_changes_reach_the_views_of_the_host_they_involve() {
    let b = bench("stamp-1");
    let view = b.view().await;
    assert_eq!(view.events().subscribers(), 0);
    let (sink, body) = channel();
    view.call(req(Initiator::Document, "GET", "http://eos.localhost/_shell/events?t=view-h1", None, Value::Null), sink);
    assert_eq!(view.events().subscribers(), 1);
    b.hosts.forward_transfer(&json!({ "transfer": { "id": "t1", "from": "local", "to": H } }));
    b.hosts.forward_transfer(&json!({ "transfer": { "id": "t9", "from": "h9", "to": "local" } }));
    let mut buf = vec![0u8; 4096];
    let n = body.read_now(&mut buf);
    let frames = String::from_utf8_lossy(&buf[..n]);
    assert!(frames.contains("transfer:changed") && frames.contains("t1") && !frames.contains("t9"), "{frames}");
}
