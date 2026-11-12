//! Fakes of the window shell's view ports: views with a scripted DevTools channel, and the
//! dashboard's browser panel.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_core::BoxFuture;
use eos_core::shell::{
    BrowserPanel, BrowserViews, PanelListener, Rect, ViewError, ViewEvent, ViewId, ViewListener, ViewSpec,
};
use serde_json::{Value, json};

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// What a fake view answers a DevTools call with.
type Answer = Arc<dyn Fn(&Value) -> Result<Value, String> + Send + Sync>;

/// Views without a window: `create` names them `bt-1`, `bt-2`, …; DevTools calls are
/// recorded and answered from what the test scripted ([`answer`](Self::answer),
/// [`answer_with`](Self::answer_with)), `{}` otherwise. A navigation becomes an entry of the
/// view's history, so the tab list reads as a real one would.
#[derive(Default)]
pub struct FakeBrowserViews {
    created: Mutex<Vec<ViewSpec>>,
    closed: Mutex<Vec<String>>,
    /// Every port call in order: `<view> <method>` for DevTools, `allow <view> <host>`,
    /// `mute <view> <bool>`, `close <view>`, `place <view>`, `park <view>`.
    calls: Mutex<Vec<String>>,
    /// The params of each DevTools call, beside `calls`.
    params: Mutex<Vec<(String, Value)>>,
    answers: Mutex<HashMap<String, Answer>>,
    once: Mutex<HashMap<String, VecDeque<Result<Value, String>>>>,
    history: Mutex<HashMap<String, (usize, Vec<Value>)>>,
    listeners: Mutex<Vec<Arc<dyn ViewListener>>>,
}

impl std::fmt::Debug for FakeBrowserViews {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeBrowserViews").field("created", &locked(&self.created).len()).finish_non_exhaustive()
    }
}

impl FakeBrowserViews {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Every later call of `method` answers `value`.
    pub fn answer(&self, method: &str, value: Value) {
        self.answer_with(method, move |_| Ok(value.clone()));
    }

    /// Every later call of `method` answers what `respond` makes of its params; `Err` is a
    /// DevTools error.
    pub fn answer_with(&self, method: &str, respond: impl Fn(&Value) -> Result<Value, String> + Send + Sync + 'static) {
        locked(&self.answers).insert(method.to_owned(), Arc::new(respond));
    }

    /// The next call of `method` answers this, once, ahead of anything scripted for good.
    pub fn answer_once(&self, method: &str, answer: Result<Value, String>) {
        locked(&self.once).entry(method.to_owned()).or_default().push_back(answer);
    }

    pub fn created(&self) -> Vec<ViewSpec> {
        locked(&self.created).clone()
    }

    pub fn closed(&self) -> Vec<String> {
        locked(&self.closed).clone()
    }

    pub fn calls(&self) -> Vec<String> {
        locked(&self.calls).clone()
    }

    /// Forgets the calls so far.
    pub fn clear_calls(&self) {
        locked(&self.calls).clear();
        locked(&self.params).clear();
    }

    /// The params of every call of `method`, in order.
    pub fn params_of(&self, method: &str) -> Vec<Value> {
        locked(&self.params).iter().filter(|(m, _)| m == method).map(|(_, p)| p.clone()).collect()
    }

    /// Delivers a view event to the listeners, as the shell would.
    pub fn emit(&self, view: &str, event: ViewEvent) {
        let listeners = locked(&self.listeners).clone();
        for listener in listeners {
            listener.on_view_event(&ViewId(view.to_owned()), &event);
        }
    }

    /// A DevTools event of the view.
    pub fn emit_cdp(&self, view: &str, method: &str, params: Value) {
        self.emit(view, ViewEvent::Cdp { method: method.to_owned(), params });
    }

    /// Sets the title of the page the view shows.
    pub fn set_title(&self, view: &str, title: &str) {
        if let Some((current, entries)) = locked(&self.history).get_mut(view)
            && let Some(entry) = entries.get_mut(*current)
        {
            entry["title"] = json!(title);
        }
    }

    fn builtin(&self, view: &str, method: &str, params: &Value) -> Option<Value> {
        let mut history = locked(&self.history);
        let (current, entries) = history.get_mut(view)?;
        match method {
            "Page.navigate" => {
                entries.truncate(*current + 1);
                entries.push(json!({ "id": entries.len() + 1, "url": params["url"], "title": "" }));
                *current = entries.len() - 1;
                Some(json!({ "frameId": "main" }))
            }
            "Page.navigateToHistoryEntry" => {
                let at = entries.iter().position(|entry| entry["id"] == params["entryId"])?;
                *current = at;
                Some(json!({}))
            }
            "Page.getNavigationHistory" => Some(json!({ "currentIndex": *current, "entries": entries.clone() })),
            _ => None,
        }
    }
}

impl BrowserViews for FakeBrowserViews {
    fn create(&self, spec: ViewSpec) -> BoxFuture<'_, Result<ViewId, ViewError>> {
        let id = {
            let mut created = locked(&self.created);
            created.push(spec);
            format!("bt-{}", created.len())
        };
        // Every view starts on a blank page.
        locked(&self.history).insert(id.clone(), (0, vec![json!({ "id": 1, "url": "about:blank", "title": "" })]));
        Box::pin(async move { Ok(ViewId(id)) })
    }

    fn close(&self, view: &ViewId) -> BoxFuture<'_, Result<(), ViewError>> {
        locked(&self.calls).push(format!("close {view}"));
        locked(&self.closed).push(view.0.clone());
        locked(&self.history).remove(view.as_str());
        Box::pin(async { Ok(()) })
    }

    fn place(&self, view: &ViewId, _rect: Rect) -> BoxFuture<'_, Result<(), ViewError>> {
        locked(&self.calls).push(format!("place {view}"));
        Box::pin(async { Ok(()) })
    }

    fn park(&self, view: &ViewId) -> BoxFuture<'_, Result<(), ViewError>> {
        locked(&self.calls).push(format!("park {view}"));
        Box::pin(async { Ok(()) })
    }

    fn set_muted(&self, view: &ViewId, muted: bool) -> BoxFuture<'_, Result<(), ViewError>> {
        locked(&self.calls).push(format!("mute {view} {muted}"));
        Box::pin(async { Ok(()) })
    }

    fn allow_local_network(&self, view: &ViewId, host: &str) -> BoxFuture<'_, Result<(), ViewError>> {
        locked(&self.calls).push(format!("allow {view} {host}"));
        Box::pin(async { Ok(()) })
    }

    fn cdp(&self, view: &ViewId, method: &str, params: Value) -> BoxFuture<'_, Result<Value, ViewError>> {
        locked(&self.calls).push(format!("{view} {method}"));
        locked(&self.params).push((method.to_owned(), params.clone()));
        let known = locked(&self.history).contains_key(view.as_str());
        let once = locked(&self.once).get_mut(method).and_then(VecDeque::pop_front);
        let scripted = locked(&self.answers).get(method).cloned();
        let answer = if !known {
            Err(ViewError::UnknownView(view.clone()))
        } else if let Some(answer) = once.or_else(|| scripted.map(|respond| respond(&params))) {
            answer.map_err(|message| ViewError::Cdp { method: method.to_owned(), message })
        } else {
            Ok(self.builtin(view.as_str(), method, &params).unwrap_or_else(|| json!({})))
        };
        Box::pin(async move { answer })
    }

    fn listen(&self, listener: Arc<dyn ViewListener>) {
        locked(&self.listeners).push(listener);
    }
}

/// A view and the device size set for it.
type DeviceSize = (String, Option<(f64, f64)>);

/// The dashboard's panel, as a recorder: what was forgotten, the device sizes set, and a way
/// to say which tab the panel shows.
#[derive(Default)]
pub struct FakeBrowserPanel {
    forgotten: Mutex<Vec<String>>,
    device_sizes: Mutex<Vec<DeviceSize>>,
    listener: Mutex<Option<Arc<dyn PanelListener>>>,
}

impl std::fmt::Debug for FakeBrowserPanel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FakeBrowserPanel").finish_non_exhaustive()
    }
}

impl FakeBrowserPanel {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn forgotten(&self) -> Vec<String> {
        locked(&self.forgotten).clone()
    }

    pub fn device_sizes(&self) -> Vec<DeviceSize> {
        locked(&self.device_sizes).clone()
    }

    /// The dashboard shows `view`, a tab of `session`.
    pub fn show(&self, session: &str, view: &str) {
        let listener = locked(&self.listener).clone();
        if let Some(listener) = listener {
            listener.active_view_changed(session, &ViewId(view.to_owned()));
        }
    }
}

impl BrowserPanel for FakeBrowserPanel {
    fn forget(&self, view: &ViewId) {
        locked(&self.forgotten).push(view.0.clone());
    }

    fn set_device_size(&self, view: &ViewId, size: Option<(f64, f64)>) {
        locked(&self.device_sizes).push((view.0.clone(), size));
    }

    fn listen(&self, listener: Arc<dyn PanelListener>) {
        *locked(&self.listener) = Some(listener);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_fake_view_keeps_a_history_and_answers_what_was_scripted() {
        let views = FakeBrowserViews::new();
        let view = views.create(ViewSpec { profile: "p".into(), url: None }).await.expect("created");
        assert_eq!(view.as_str(), "bt-1");
        views.cdp(&view, "Page.navigate", json!({ "url": "https://a.test/" })).await.expect("navigated");
        let history = views.cdp(&view, "Page.getNavigationHistory", json!({})).await.expect("history");
        assert_eq!(history["currentIndex"], 1);
        assert_eq!(history["entries"][1]["url"], "https://a.test/");

        views.answer("DOM.getBoxModel", json!({ "model": { "border": [0, 0, 10, 0, 10, 10, 0, 10] } }));
        views.answer_once("DOM.getBoxModel", Err("gone".into()));
        assert!(views.cdp(&view, "DOM.getBoxModel", json!({})).await.is_err());
        assert!(views.cdp(&view, "DOM.getBoxModel", json!({})).await.is_ok());
        assert_eq!(views.calls().last().map(String::as_str), Some("bt-1 DOM.getBoxModel"));
        assert!(views.cdp(&ViewId("bt-9".into()), "Page.reload", json!({})).await.is_err());
    }
}
