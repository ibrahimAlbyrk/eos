//! The browser module on its own: its routes and tools over fake views (no window), the real
//! store over the seeded rows. What the TypeScript tests of `manager/modules/browser` pin.

use std::sync::{Arc, Mutex};

use eos_contracts::{BrowserNewTabRequest, BrowserShowRequest};
use eos_core::browser::{BrowserCall, BrowserTools};
use eos_core::shell::{BrowserPanel, BrowserViews, ViewEvent};
use eos_core::store::{EventOrder, EventQuery};
use eos_mod_browser::{BrowserModule, PRESENT_RATE_LIMIT_MS, Ports};
use eos_runtime::access::Caller;
use eos_runtime::http::{Method, Request};
use eos_runtime::module::Module;
use eos_runtime::router::AllPluginsOn;
use eos_runtime::{Kernel, KernelOptions, Runtime};
use eos_testkit::{FakeBrowserPanel, FakeBrowserViews, FakeClock, FakeConfig, FakeSleeper, TempStore};
use serde_json::{Value, json};

struct Fixture {
    runtime: Runtime,
    module: Arc<BrowserModule>,
    views: Arc<FakeBrowserViews>,
    panel: Arc<FakeBrowserPanel>,
    clock: Arc<FakeClock>,
    sleeper: Arc<FakeSleeper>,
    temp: TempStore,
    /// `(topic, payload)` of every browser event, in delivery order.
    events: Arc<Mutex<Vec<(String, Value)>>>,
    _subscriptions: Vec<eos_runtime::bus::Subscription>,
}

/// `browser`: the `browser` section of `config.json`; `window`: whether the shell is there.
fn fixture_with(browser: Value, window: bool) -> Fixture {
    let temp = TempStore::seeded("/sandbox");
    let (clock, sleeper) = (Arc::new(FakeClock::new()), Arc::new(FakeSleeper::default()));
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ..KernelOptions::default() });
    let (views, panel) = (FakeBrowserViews::new(), FakeBrowserPanel::new());
    let shell = window.then(|| (views.clone() as Arc<dyn BrowserViews>, panel.clone() as Arc<dyn BrowserPanel>));
    let trash = temp.home.join("trash");
    let module = Arc::new(BrowserModule::new(Ports {
        shell,
        config: Arc::new(FakeConfig::new(json!({ "browser": browser }))),
        store: temp.port(),
        files: Arc::new(eos_fs::DiskFileSystem::new(eos_platform::host(), trash)),
        clock: clock.clone(),
        sleeper: sleeper.clone(),
        bus: kernel.bus.clone(),
    }));
    let events = Arc::new(Mutex::new(Vec::new()));
    let subscriptions = ["browser:tabs", "browser:status", "browser:activity"]
        .into_iter()
        .map(|topic| {
            let events = events.clone();
            kernel.bus.on(topic, move |event| {
                let payload = event.payload_as::<Value>().unwrap_or(Value::Null);
                events.lock().expect("events").push((event.topic.to_string(), payload));
            })
        })
        .collect();
    let runtime = Runtime::build(kernel, vec![module.clone()], Arc::new(AllPluginsOn)).expect("composes");
    assert_eq!(runtime.router.undeclared(), Vec::<String>::new(), "every route has an access rule");
    Fixture { runtime, module, views, panel, clock, sleeper, temp, events, _subscriptions: subscriptions }
}

fn fixture() -> Fixture {
    fixture_with(json!({}), true)
}

/// The seeded rows: `o-ORCH` is the root of `w-KID1` and `w-KID2`; `w-CHAT` is its own root.
const CHILD: &str = "w-KID1";
const ROOT: &str = "o-ORCH";
const OTHER: &str = "w-CHAT";

impl Fixture {
    async fn call(&self, method: Method, target: &str, agent: Option<&str>, body: Option<Value>) -> (u16, Value) {
        let caller = if agent.is_some() { Caller::UNTRUSTED } else { Caller::DASHBOARD };
        let mut request = Request::new(method, target, caller);
        if let Some(agent) = agent.filter(|a| !a.is_empty()) {
            request = request.header("x-eos-agent-id", agent);
        }
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(body.to_string());
        }
        let response = self.runtime.router.handle(request).await;
        let status = response.status;
        let bytes = response.body.collect().await.expect("a body");
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    /// As the user's own window.
    async fn user(&self, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
        self.call(method, target, None, body).await
    }

    /// As an agent; `""` is a caller nobody can name.
    async fn agent(&self, agent: &str, method: Method, target: &str, body: Option<Value>) -> (u16, Value) {
        self.call(method, target, Some(agent), body).await
    }

    async fn open(&self, agent: Option<&str>, session: Option<&str>, url: Option<&str>) -> String {
        let target = session.map_or("/browser/tabs".to_owned(), |s| format!("/browser/tabs?session={s}"));
        let body = url.map_or(json!({}), |url| json!({ "url": url }));
        let (status, answer) = self.call(Method::Post, &target, agent, Some(body)).await;
        assert_eq!(status, 200, "{answer}");
        answer["tabId"].as_str().expect("a tab id").to_owned()
    }

    async fn events(&self) -> Vec<(String, Value)> {
        self.runtime.kernel.bus.flush().await;
        std::mem::take(&mut *self.events.lock().expect("events"))
    }

    async fn timeline(&self, worker: &str) -> Vec<Value> {
        let worker = worker.to_owned();
        let rows = self
            .temp
            .port()
            .read(move |tx| {
                let query = EventQuery {
                    worker_id: worker,
                    since: 0,
                    limit: 1000,
                    order: EventOrder::Asc,
                    before_id: None,
                    after_id: None,
                };
                tx.events().list(&query)
            })
            .await
            .expect("the timeline");
        rows.into_iter()
            .filter(|row| row.kind.as_str() == "browser_action")
            .map(|row| serde_json::from_str(row.payload.as_deref().unwrap_or("null")).expect("a payload"))
            .collect()
    }

    /// A page with one button and one text field, as the accessibility tree reports it.
    fn page(&self) {
        self.views.answer(
            "Accessibility.getFullAXTree",
            json!({ "nodes": [
                { "nodeId": "1", "role": { "value": "RootWebArea" }, "childIds": ["2", "3"] },
                { "nodeId": "2", "role": { "value": "button" }, "name": { "value": "Go" }, "backendDOMNodeId": 42, "childIds": [] },
                { "nodeId": "3", "role": { "value": "textbox" }, "name": { "value": "Query" }, "backendDOMNodeId": 43, "childIds": [] },
            ] }),
        );
        self.views.answer("DOM.getBoxModel", json!({ "model": { "border": [10, 20, 110, 20, 110, 60, 10, 60] } }));
        self.views.answer("DOM.describeNode", json!({ "node": { "nodeName": "BUTTON", "attributes": ["id", "go"] } }));
        self.views.answer("DOM.resolveNode", json!({ "object": { "objectId": "obj-1" } }));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_browser_that_is_switched_off_refuses_every_entry_point() {
    let f = fixture_with(json!({ "enabled": false }), true);
    let (status, answer) = f.user(Method::Get, "/browser/status", None).await;
    assert_eq!((status, &answer["state"]), (200, &json!("disabled")));
    for (method, target) in [
        (Method::Post, "/browser/launch"),
        (Method::Get, "/browser/tabs"),
        (Method::Get, "/browser/active-tab"),
        (Method::Post, "/browser/tabs"),
        (Method::Delete, "/browser/tabs/bt-1"),
        (Method::Post, "/browser/tabs/bt-1/snapshot"),
    ] {
        let (status, answer) = f.user(method, target, Some(json!({}))).await;
        assert_eq!((status, answer), (409, json!({ "error": "browser subsystem is disabled" })), "{target}");
    }
    assert!(f.views.created().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_window_the_browser_is_absent() {
    let f = fixture_with(json!({}), false);
    let (_, status) = f.user(Method::Get, "/browser/status", None).await;
    assert_eq!(status, json!({ "state": "absent", "chromePath": null, "tabCount": 0, "sessionId": "global" }));
    assert_eq!(f.user(Method::Get, "/browser/tabs", None).await.1["tabs"], json!([]));
    assert_eq!(f.user(Method::Post, "/browser/tabs", Some(json!({}))).await.0, 500);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_tab_starts_the_sessions_browser_on_its_own_storage_and_opens_blank() {
    let f = fixture();
    let (_, before) = f.user(Method::Get, "/browser/status", None).await;
    assert_eq!(before["state"], "launching", "there, but not used yet");
    let tab = f.open(None, None, None).await;
    assert_eq!(tab, "bt-1");
    assert_eq!(f.views.created()[0].profile, "browser-profile");
    assert!(!f.views.calls().iter().any(|c| c.ends_with("Page.navigate")), "no start site");

    let (_, status) = f.user(Method::Get, "/browser/status", None).await;
    assert_eq!(
        status,
        json!({ "state": "running", "chromePath": "WebContentsView (embedded)", "tabCount": 1, "sessionId": "global" })
    );
    let (_, tabs) = f.user(Method::Get, "/browser/tabs", None).await;
    assert_eq!(
        tabs,
        json!({ "tabs": [{
            "tabId": "bt-1", "sessionId": "global", "url": "about:blank", "title": "", "loading": false,
            "canGoBack": false, "canGoForward": false, "audible": false, "muted": false, "faviconDataUri": null,
        }], "sessionId": "global" })
    );
    let events = f.events().await;
    let topics: Vec<&str> = events.iter().map(|(topic, _)| topic.as_str()).collect();
    assert_eq!(topics, ["browser:status", "browser:tabs"]);
    assert_eq!(events[1].1["tabs"][0]["tabId"], "bt-1");
}

#[tokio::test(flavor = "multi_thread")]
async fn this_page_is_the_newest_tab_then_the_shown_one_and_never_a_guess() {
    let f = fixture();
    let none = f.user(Method::Get, "/browser/active-tab", None).await;
    assert_eq!(none, (409, json!({ "error": "no active tab" })));
    assert_eq!(
        f.user(Method::Post, "/browser/show", Some(json!({}))).await,
        (409, json!({ "error": "no active tab" }))
    );

    let (a, b) = (f.open(None, None, None).await, f.open(None, None, None).await);
    assert_eq!(f.user(Method::Get, "/browser/active-tab", None).await.1, json!({ "tabId": b }));
    // An explicit "look here".
    assert_eq!(
        f.user(Method::Post, "/browser/show", Some(json!({ "tabId": a }))).await,
        (200, json!({ "ok": true, "tabId": a }))
    );
    assert_eq!(f.user(Method::Get, "/browser/active-tab", None).await.1, json!({ "tabId": a }));
    // Closing it leaves no pointer: the tab the panel shows is the fallback, and nothing else.
    assert_eq!(f.user(Method::Delete, &format!("/browser/tabs/{a}"), None).await, (200, json!({ "ok": true })));
    assert_eq!(f.user(Method::Get, "/browser/active-tab", None).await.0, 409, "no first-tab fallback");
    f.panel.show("global", &b);
    assert_eq!(f.user(Method::Get, "/browser/active-tab", None).await.1, json!({ "tabId": b }));
    assert_eq!(f.panel.forgotten(), std::slice::from_ref(&a));
    assert_eq!(f.views.closed(), [a]);
}

#[tokio::test(flavor = "multi_thread")]
async fn who_is_calling_comes_from_what_the_request_proves() {
    let f = fixture();
    // The user's window names its session; a body cannot change who is calling.
    let (_, status) = f.user(Method::Get, &format!("/browser/status?session={OTHER}"), None).await;
    assert_eq!(status["sessionId"], OTHER);
    // A child agent drives its root's session; its `?session=` is ignored.
    let (_, status) = f.agent(CHILD, Method::Get, &format!("/browser/status?session={OTHER}"), None).await;
    assert_eq!(status["sessionId"], ROOT);
    let tab = f.open(Some(CHILD), None, None).await;
    assert_eq!(f.views.created()[0].profile, format!("browser-{ROOT}"));
    let (_, mine) = f.agent(ROOT, Method::Get, "/browser/tabs", None).await;
    assert_eq!(mine["tabs"][0]["tabId"], tab.as_str());
    let (_, theirs) = f.agent(OTHER, Method::Get, "/browser/tabs", None).await;
    assert_eq!(theirs, json!({ "tabs": [], "sessionId": OTHER }));

    // Nobody: refused, on every route, before anything else is looked at.
    for agent in ["", "w-nope"] {
        for (method, target) in
            [(Method::Get, "/browser/status"), (Method::Post, "/browser/tabs"), (Method::Delete, "/browser/tabs/x")]
        {
            let (status, answer) =
                f.agent(agent, method, target, Some(json!({ "actor": "human", "session": ROOT }))).await;
            assert_eq!(status, 409, "{target}");
            assert_eq!(answer["error"], "unattributed agent call — x-eos-agent-id missing or unknown");
        }
    }

    // Another session's tab is refused; an unknown one is not found.
    let (status, answer) =
        f.agent(OTHER, Method::Post, &format!("/browser/tabs/{tab}/snapshot"), Some(json!({}))).await;
    assert_eq!((status, answer), (403, json!({ "error": "tab belongs to another session" })));
    assert_eq!(f.user(Method::Delete, &format!("/browser/tabs/{tab}"), None).await.0, 403, "the global session's too");
    let (status, answer) =
        f.agent(CHILD, Method::Post, "/browser/tabs/bt-99/navigate", Some(json!({ "action": "reload" }))).await;
    assert_eq!((status, answer), (404, json!({ "error": "unknown tab: bt-99" })));
}

#[tokio::test(flavor = "multi_thread")]
async fn one_shared_browser_when_sessions_are_switched_off() {
    let f = fixture_with(json!({ "perSession": false }), true);
    let a = f.open(Some(CHILD), None, None).await;
    let b = f.open(Some(""), None, None).await;
    let c = f.open(None, Some(OTHER), None).await;
    let (_, tabs) = f.agent(OTHER, Method::Get, "/browser/tabs", None).await;
    assert_eq!(tabs["sessionId"], "global");
    let ids: Vec<&str> =
        tabs["tabs"].as_array().expect("tabs").iter().map(|t| t["tabId"].as_str().expect("id")).collect();
    assert_eq!(ids, [a.as_str(), b.as_str(), c.as_str()]);
    assert!(f.views.created().iter().all(|spec| spec.profile == "browser-profile"));
    // A session that ends takes nothing with it.
    f.module.on_session_ended(ROOT);
    assert_eq!(f.user(Method::Get, "/browser/tabs", None).await.1["tabs"].as_array().map(Vec::len), Some(3));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_origin_allowlist_holds_agents_and_never_the_user() {
    let f = fixture_with(json!({ "allowedOrigins": ["https://example.com"] }), true);
    let tab = f.open(Some(CHILD), None, Some("https://example.com/start")).await;
    let outside = json!({ "action": "url", "url": "https://other.test/" });
    let (status, answer) =
        f.agent(CHILD, Method::Post, &format!("/browser/tabs/{tab}/navigate"), Some(outside.clone())).await;
    assert_eq!(status, 403);
    assert!(
        answer["error"].as_str().is_some_and(|e| e.starts_with("navigation blocked: https://other.test is not in"))
    );
    // The rule comes before the tab: refused also on a tab that does not exist.
    assert_eq!(f.agent(CHILD, Method::Post, "/browser/tabs/bt-99/navigate", Some(outside.clone())).await.0, 403);
    assert_eq!(
        f.agent(CHILD, Method::Post, "/browser/tabs", Some(json!({ "url": "https://other.test/" }))).await.0,
        403
    );
    // The same from the user's own panel goes through.
    let own = f.open(None, Some(ROOT), Some("https://other.test/")).await;
    assert_eq!(
        f.user(Method::Post, &format!("/browser/tabs/{own}/navigate?session={ROOT}"), Some(outside)).await.0,
        200
    );
    let missing = f
        .user(Method::Post, &format!("/browser/tabs/{own}/navigate?session={ROOT}"), Some(json!({ "action": "url" })))
        .await;
    assert_eq!(missing, (500, json!({ "error": "navigate action 'url' requires a url" })));
}

#[tokio::test(flavor = "multi_thread")]
async fn what_someone_asked_for_may_reach_the_local_network_and_a_pages_own_popup_may_not() {
    let f = fixture();
    // An agent opening its dev server: the view is told before it navigates.
    let tab = f.open(Some(CHILD), None, Some("http://localhost:5173/app")).await;
    let calls = f.views.calls();
    let allow = calls.iter().position(|c| c == "allow bt-1 localhost").expect("the view was told");
    let navigate = calls.iter().position(|c| c == "bt-1 Page.navigate").expect("navigated");
    assert!(allow < navigate, "{calls:?}");
    // The same for an address typed in the panel, and for going back to it.
    let route = format!("/browser/tabs/{tab}/navigate?session={ROOT}");
    f.user(Method::Post, &route, Some(json!({ "action": "url", "url": "http://192.168.1.20:3000/" }))).await;
    f.user(Method::Post, &route, Some(json!({ "action": "url", "url": "https://example.com/" }))).await;
    f.views.clear_calls();
    assert_eq!(f.user(Method::Post, &route, Some(json!({ "action": "back" }))).await.0, 200);
    assert_eq!(f.views.calls()[1..3], ["allow bt-1 192.168.1.20", "bt-1 Page.navigateToHistoryEntry"]);

    // A popup becomes a tab of the same session, with no way in.
    f.views.clear_calls();
    f.views.emit(&tab, ViewEvent::OpenRequested { url: "http://192.168.1.5/admin".into() });
    f.views.emit(&tab, ViewEvent::OpenRequested { url: "javascript:alert(1)".into() });
    for _ in 0..200 {
        if f.views.created().len() == 2 && f.views.calls().iter().any(|c| c == "bt-2 Page.navigate") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(f.views.created().len(), 2, "only the web address became a tab");
    assert!(!f.views.calls().iter().any(|c| c.starts_with("allow")), "{:?}", f.views.calls());
    assert_eq!(f.views.created()[1].profile, format!("browser-{ROOT}"));
    // It is a tab like any other: listed, and it can be driven and closed.
    let (_, tabs) = f.agent(CHILD, Method::Get, "/browser/tabs", None).await;
    assert_eq!(tabs["tabs"][1]["url"], "http://192.168.1.5/admin");
    assert_eq!(f.agent(CHILD, Method::Delete, "/browser/tabs/bt-2", None).await.0, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agents_new_tab_and_page_load_are_announced_and_put_on_its_timeline() {
    let f = fixture();
    let tab = f.open(Some(CHILD), None, Some("https://example.com/")).await;
    let route = format!("/browser/tabs/{tab}");
    f.agent(
        CHILD,
        Method::Post,
        &format!("{route}/navigate"),
        Some(json!({ "action": "url", "url": "https://example.com/docs" })),
    )
    .await;
    // Nothing for a reload, a key press, or anything the user does.
    f.agent(CHILD, Method::Post, &format!("{route}/navigate"), Some(json!({ "action": "reload" }))).await;
    f.agent(CHILD, Method::Post, &format!("{route}/act"), Some(json!({ "key": "Enter" }))).await;
    f.user(
        Method::Post,
        &format!("{route}/navigate?session={ROOT}"),
        Some(json!({ "action": "url", "url": "https://example.com/user" })),
    )
    .await;
    f.open(None, Some(ROOT), Some("https://example.com/")).await;

    let activity: Vec<Value> =
        f.events().await.into_iter().filter(|(t, _)| t == "browser:activity").map(|(_, p)| p).collect();
    assert_eq!(
        activity,
        [
            json!({ "sessionId": ROOT, "workerId": CHILD, "kind": "use", "tabId": tab, "url": "https://example.com/" }),
            json!({ "sessionId": ROOT, "workerId": CHILD, "kind": "use", "tabId": tab, "url": "https://example.com/docs" }),
        ]
    );
    assert_eq!(
        f.timeline(CHILD).await,
        [
            json!({ "tabId": tab, "verb": "new_tab", "url": "https://example.com/" }),
            json!({ "tabId": tab, "verb": "navigate", "url": "https://example.com/docs" }),
        ]
    );

    // Presenting: once per session per quiet window.
    let show = || f.agent(CHILD, Method::Post, "/browser/show", Some(json!({})));
    assert_eq!(show().await, (200, json!({ "ok": true, "tabId": "bt-2" })), "the newest tab of the session");
    assert_eq!(show().await.0, 200);
    f.clock.advance(PRESENT_RATE_LIMIT_MS);
    show().await;
    let presents: Vec<Value> =
        f.events().await.into_iter().filter(|(t, _)| t == "browser:activity").map(|(_, p)| p).collect();
    assert_eq!(presents.len(), 2, "the second of three fell inside the window");
    assert_eq!(
        presents[0],
        json!({ "sessionId": ROOT, "workerId": CHILD, "kind": "present", "tabId": "bt-2", "url": "https://example.com/" })
    );
    assert_eq!(f.timeline(CHILD).await.len(), 4);
    assert_eq!(f.timeline(CHILD).await[2], json!({ "tabId": "bt-2", "verb": "show", "url": "https://example.com/" }));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_snapshot_mints_refs_a_click_is_trusted_input_and_a_navigation_makes_refs_stale() {
    let f = fixture();
    f.page();
    let tab = f.open(Some(CHILD), None, Some("https://example.com/")).await;
    let route = format!("/browser/tabs/{tab}");
    let (status, snapshot) = f.agent(CHILD, Method::Post, &format!("{route}/snapshot"), Some(json!({}))).await;
    assert_eq!(status, 200);
    assert_eq!(
        snapshot,
        json!({ "tabId": tab, "url": "https://example.com/", "snapshot": "button \"Go\" @e1\ntextbox \"Query\" @e2" })
    );

    f.views.clear_calls();
    let clicked =
        f.agent(CHILD, Method::Post, &format!("{route}/act"), Some(json!({ "ref": "@e1", "verb": "click" }))).await;
    assert_eq!(clicked, (200, json!({ "ok": true })));
    let mouse = f.views.params_of("Input.dispatchMouseEvent");
    let kinds: Vec<&str> = mouse.iter().map(|m| m["type"].as_str().expect("type")).collect();
    assert_eq!(kinds, ["mouseMoved", "mousePressed", "mouseReleased"]);
    assert_eq!(
        mouse[1],
        json!({ "type": "mousePressed", "x": 60.0, "y": 40.0, "button": "left", "buttons": 1, "clickCount": 1, "deltaX": 0, "deltaY": 0 })
    );

    // Typing replaces the field's content; `submit` presses Enter.
    f.views.clear_calls();
    let typed = json!({ "ref": "@e2", "text": "hello", "submit": true, "includeSnapshot": true });
    let (status, answer) = f.agent(CHILD, Method::Post, &format!("{route}/act"), Some(typed)).await;
    assert_eq!(status, 200);
    assert_eq!(answer["snapshot"]["snapshot"], "button \"Go\" @e3\ntextbox \"Query\" @e4", "refs are never reused");
    assert_eq!(f.views.params_of("Input.insertText"), [json!({ "text": "hello" })]);
    let keys = f.views.params_of("Input.dispatchKeyEvent");
    assert_eq!(
        (keys[0]["type"].as_str(), keys[0]["key"].as_str(), keys[1]["type"].as_str()),
        (Some("keyDown"), Some("Enter"), Some("keyUp"))
    );

    // The other shapes of the shared route.
    let fill = json!({ "fields": [{ "ref": "@e4", "value": "a" }, { "ref": "@e4", "value": "b" }] });
    assert_eq!(f.agent(CHILD, Method::Post, &format!("{route}/act"), Some(fill)).await, (200, json!({ "ok": true })));
    assert_eq!(
        f.agent(CHILD, Method::Post, &format!("{route}/act"), Some(json!({ "direction": "down" }))).await.0,
        200
    );
    let (status, answer) = f.agent(CHILD, Method::Post, &format!("{route}/act"), Some(json!({ "nothing": 1 }))).await;
    assert_eq!(status, 400);
    assert!(answer["error"].as_str().is_some_and(|e| e.starts_with("unrecognized act body")));
    let (status, answer) =
        f.agent(CHILD, Method::Post, &format!("{route}/act"), Some(json!({ "key": "Hyper+a" }))).await;
    assert_eq!((status, answer), (500, json!({ "error": "unknown modifier \"Hyper\" in \"Hyper+a\"" })));

    // find answers elements, each with a fresh ref and a durable locator.
    let (_, found) = f.agent(CHILD, Method::Post, &format!("{route}/find"), Some(json!({ "query": "/^g/" }))).await;
    assert_eq!(
        found,
        json!({ "tabId": tab, "url": "https://example.com/", "matches": [{
            "ref": "@e5", "tag": "button", "role": "button", "name": "Go", "box": [10, 20, 100, 40], "focusable": false,
            "locator": "role=button[name=\"Go\"]",
        }] })
    );

    // A main-frame navigation: every ref from before it is refused, with what to do.
    f.views.emit_cdp(&tab, "Page.frameNavigated", json!({ "frame": { "id": "F2" } }));
    let (status, answer) =
        f.agent(CHILD, Method::Post, &format!("{route}/act"), Some(json!({ "ref": "@e5", "verb": "click" }))).await;
    assert_eq!(status, 409);
    assert_eq!(
        answer["error"],
        "unknown or stale ref \"@e5\" — the page has changed since it was minted; call snapshot (or find) again for fresh refs"
    );
    // A frame inside the page changes nothing.
    f.agent(CHILD, Method::Post, &format!("{route}/snapshot"), Some(json!({}))).await;
    f.views.emit_cdp(&tab, "Page.frameNavigated", json!({ "frame": { "id": "F3", "parentId": "F2" } }));
    assert_eq!(
        f.agent(CHILD, Method::Post, &format!("{route}/act"), Some(json!({ "ref": "@e6", "verb": "focus" }))).await.0,
        200
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn reading_capturing_muting_and_waiting() {
    let f = fixture();
    f.page();
    let tab = f.open(None, None, Some("https://example.com/")).await;
    f.views.set_title(&tab, "Example");
    let route = format!("/browser/tabs/{tab}");
    let get_route = format!("{route}/get");
    let get = |what: &str| f.user(Method::Post, &get_route, Some(json!({ "what": what })));
    assert_eq!(get("url").await.1, json!({ "tabId": tab, "what": "url", "value": "https://example.com/" }));
    assert_eq!(get("title").await.1["value"], "Example");
    assert_eq!(get("value").await, (500, json!({ "error": "get 'value' requires a ref" })));

    // A capture is a file an agent reads.
    f.views.answer("Page.captureScreenshot", json!({ "data": "anBlZw==" }));
    let (status, shot) = f.user(Method::Post, &format!("{route}/capture"), Some(json!({}))).await;
    assert_eq!(status, 200);
    let path = std::path::PathBuf::from(shot["path"].as_str().expect("a path"));
    assert_eq!(std::fs::read(&path).expect("the capture"), b"jpeg");
    let name = path.file_name().and_then(|n| n.to_str()).expect("a name").to_owned();
    assert_eq!(name, format!("browser-{tab}-{}.jpeg", FakeClock::START_MS));
    assert!(path.parent().and_then(|p| p.file_name()).is_some_and(|d| d.to_string_lossy().starts_with("eos-paste-")));
    let _ = std::fs::remove_dir_all(path.parent().expect("a folder"));

    assert_eq!(
        f.user(Method::Post, &format!("{route}/mute"), Some(json!({ "muted": true }))).await,
        (200, json!({ "ok": true }))
    );
    assert!(f.views.calls().contains(&format!("mute {tab} true")));
    assert_eq!(f.user(Method::Get, "/browser/tabs", None).await.1["tabs"][0]["muted"], true);

    // A fixed wait sleeps once; a wait for text looks every quarter second until it gives up.
    let (status, answer) = f.user(Method::Post, &format!("{route}/wait"), Some(json!({}))).await;
    assert_eq!((status, answer), (500, json!({ "error": "wait requires forText, forRef, or forMs" })));
    f.views.answer("Runtime.evaluate", json!({ "result": { "value": false } }));
    let waiting = {
        let (router, route) = (f.runtime.router.clone(), format!("{route}/wait"));
        tokio::spawn(async move {
            let body = json!({ "forText": "Done", "timeoutMs": 600 }).to_string();
            let response = router.handle(Request::new(Method::Post, &route, Caller::DASHBOARD).body(body)).await;
            serde_json::from_slice::<Value>(&response.body.collect().await.expect("a body")).expect("json")
        })
    };
    let mut polls = 0;
    while !waiting.is_finished() {
        if f.sleeper.pending().contains(&250) {
            f.clock.advance(250);
            polls += u32::from(f.sleeper.wake());
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert_eq!(waiting.await.expect("the wait"), json!({ "ok": false, "timedOut": true, "elapsedMs": 500 }));
    assert_eq!(polls, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_is_emulated_and_shown_at_its_size_and_the_picker_mints_a_ref() {
    let f = fixture();
    f.page();
    let tab = f.open(None, None, Some("https://example.com/")).await;
    let route = format!("/browser/tabs/{tab}");
    assert_eq!(f.user(Method::Post, &format!("{route}/device"), Some(json!({ "device": "mobile" }))).await.0, 200);
    assert_eq!(
        f.views.params_of("Emulation.setDeviceMetricsOverride"),
        [json!({ "width": 375, "height": 812, "deviceScaleFactor": 3, "mobile": true })]
    );
    assert_eq!(f.views.params_of("Emulation.setUserAgentOverride")[0]["platform"], "iPhone");
    assert_eq!(f.user(Method::Post, &format!("{route}/device"), Some(json!({ "device": "responsive" }))).await.0, 200);
    assert_eq!(f.panel.device_sizes(), [(tab.clone(), Some((375.0, 812.0))), (tab.clone(), None)]);
    assert_eq!(f.views.params_of("Emulation.setUserAgentOverride")[1], json!({ "userAgent": "" }));
    assert_eq!(f.views.calls().iter().filter(|c| c.ends_with("Page.reload")).count(), 2);

    // The picker: the overlay reports the node the user clicked.
    f.views.answer("DOM.getNodeForLocation", json!({ "backendNodeId": 42 }));
    f.views.answer(
        "Accessibility.getPartialAXTree",
        json!({ "nodes": [{ "nodeId": "2", "role": { "value": "button" }, "name": { "value": " Go\n now " } }] }),
    );
    let (_, at) = f.user(Method::Post, &format!("{route}/elements"), Some(json!({ "at": [59.6, 40.2] }))).await;
    assert_eq!(at["name"], "Go now");
    assert_eq!(
        f.views.params_of("DOM.getNodeForLocation")[0],
        json!({ "x": 60.0, "y": 40.0, "includeUserAgentShadowDOM": false })
    );
    assert_eq!(f.user(Method::Post, &format!("{route}/elements"), Some(json!({}))).await.0, 500);

    let picker = f.module.element_picker();
    let picking = {
        let (picker, tab) = (picker.clone(), tab.clone());
        tokio::spawn(async move { picker.pick(&tab).await })
    };
    for _ in 0..500 {
        if f.views.calls().iter().any(|c| c.ends_with("Overlay.setInspectMode")) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    f.views.emit_cdp(&tab, "Overlay.inspectNodeRequested", json!({ "backendNodeId": 42 }));
    let picked = picking.await.expect("the pick").expect("an element");
    assert_eq!((picked.r#ref.as_str(), picked.locator.as_str()), ("@e2", "role=button[name=\"Go now\"]"));
    assert_eq!(f.views.params_of("Overlay.setInspectMode").last().map(|p| p["mode"].clone()), Some(json!("none")));

    // A pick that is cancelled answers nothing; so does one on an unknown tab.
    let picking = {
        let (picker, tab) = (picker.clone(), tab.clone());
        tokio::spawn(async move { picker.pick(&tab).await })
    };
    let before = f.views.params_of("Overlay.setInspectMode").len();
    for _ in 0..500 {
        if f.views.params_of("Overlay.setInspectMode").len() > before {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    picker.cancel();
    assert!(picking.await.expect("the pick").is_none());
    assert!(picker.pick("bt-99").await.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn what_a_page_changes_is_announced_once_it_settles_and_an_ended_session_closes_its_tabs() {
    let f = fixture();
    let tab = f.open(Some(CHILD), None, Some("https://example.com/")).await;
    let other = f.open(Some(OTHER), None, None).await;
    f.events().await;
    for method in ["Page.frameStartedLoading", "Page.loadEventFired", "Page.frameStoppedLoading"] {
        f.views.emit_cdp(&tab, method, json!({ "frameId": "main" }));
    }
    for _ in 0..200 {
        if !f.sleeper.pending().is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert_eq!(f.sleeper.pending(), [250], "one announcement for the burst");
    assert!(f.events().await.is_empty());
    f.sleeper.wake();
    let mut announced = Vec::new();
    for _ in 0..200 {
        announced = f.events().await;
        if !announced.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert_eq!(announced.len(), 1);
    assert_eq!((announced[0].0.as_str(), &announced[0].1["sessionId"]), ("browser:tabs", &json!(ROOT)));

    // The session's root is removed: its tabs close, the other session's stay.
    f.module.on_session_ended(ROOT);
    for _ in 0..200 {
        if f.views.closed().contains(&tab) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    }
    assert_eq!(f.views.closed(), [tab]);
    let events = f.events().await;
    assert!(events.contains(&("browser:tabs".to_owned(), json!({ "sessionId": ROOT, "tabs": [] }))), "{events:?}");
    let status = events.iter().find(|(topic, _)| topic == "browser:status").expect("a status");
    assert_eq!((&status.1["state"], &status.1["sessionId"]), (&json!("launching"), &json!(ROOT)));
    // Quitting closes the rest.
    f.module.stop().await;
    assert_eq!(f.views.closed().len(), 2);
    assert!(f.views.closed().contains(&other));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tools_answer_what_the_routes_answer_the_same_agent() {
    let f = fixture();
    let tools: Arc<dyn BrowserTools> = f.module.tools();
    let none = tools.call(CHILD, BrowserCall::ActiveTab).await.expect_err("no tab yet");
    assert_eq!((none.status, none.message.as_str()), (409, "no active tab"));
    let opened = tools
        .call(CHILD, BrowserCall::NewTab(BrowserNewTabRequest { url: Some("http://localhost:3000/".into()) }))
        .await
        .expect("a tab");
    assert_eq!(opened, json!({ "tabId": "bt-1" }));
    assert!(f.views.calls().contains(&"allow bt-1 localhost".to_owned()));
    assert_eq!(tools.call(CHILD, BrowserCall::ActiveTab).await.expect("active"), json!({ "tabId": "bt-1" }));
    assert_eq!(tools.call(ROOT, BrowserCall::Tabs).await.expect("tabs")["sessionId"], ROOT);
    assert_eq!(
        tools.call(CHILD, BrowserCall::Show(BrowserShowRequest { tab_id: None })).await.expect("shown")["tabId"],
        "bt-1"
    );
    assert_eq!(f.timeline(CHILD).await.len(), 2, "new_tab and show");
    // Another session's agent, and an agent nobody knows.
    let fenced = tools.call(OTHER, BrowserCall::CloseTab { tab_id: "bt-1".into() }).await.expect_err("fenced");
    assert_eq!((fenced.status, fenced.message.as_str()), (403, "tab belongs to another session"));
    assert_eq!(tools.call("w-nope", BrowserCall::Tabs).await.expect_err("unknown").status, 409);
    assert_eq!(
        tools.call(CHILD, BrowserCall::CloseTab { tab_id: "bt-1".into() }).await.expect("closed"),
        json!({ "ok": true })
    );
}
