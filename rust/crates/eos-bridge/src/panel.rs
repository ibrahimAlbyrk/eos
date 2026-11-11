//! Where the browser panel's view sits. The dashboard measures the panel's placeholder and
//! reports rectangle, visibility and the active tab; this module turns that into `place` and
//! `park` calls on the shell's views.
//!
//! The reports travel as independent requests, so each kind carries a sequence number and a
//! report older than the last one applied is dropped. One task applies the latest wanted
//! state, so a burst of reports (a splitter drag) costs few native calls and never lands out
//! of order.

use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::shell::{BrowserViews, Rect, ViewId};
use tokio::sync::Notify;

/// The independent reports of the panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flag {
    /// The panel is on screen at all.
    Visible,
    /// A modal, menu or palette is open: it must draw above the native view.
    Overlay,
    /// Another DOM layer overlaps the panel.
    Occluded,
}

/// Told when the dashboard shows another tab, so "the page the human sees" stays exact.
pub trait PanelListener: Send + Sync {
    fn active_view_changed(&self, session: &str, view: &ViewId);
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Seqs {
    active: u64,
    bounds: u64,
    visible: u64,
    overlay: u64,
    occluded: u64,
}

/// A report is stale when a later one of its kind was already applied. 0 means unordered.
fn accept(last: &mut u64, seq: u64) -> bool {
    if seq != 0 && seq < *last {
        return false;
    }
    *last = seq.max(*last);
    true
}

/// What the dashboard last said, and what follows from it. No I/O.
#[derive(Debug, Clone, PartialEq)]
struct Geometry {
    current: Option<ViewId>,
    session: String,
    bounds: Rect,
    visible: bool,
    overlay: bool,
    occluded: bool,
    seqs: Seqs,
}

impl Default for Geometry {
    fn default() -> Self {
        Geometry {
            current: None,
            session: String::new(),
            bounds: Rect::default(),
            visible: true,
            overlay: false,
            occluded: false,
            seqs: Seqs::default(),
        }
    }
}

/// Where the current view should be.
#[derive(Debug, Clone, PartialEq)]
enum Wanted {
    Nothing,
    Placed(ViewId, Rect),
    Parked(ViewId),
}

impl Wanted {
    fn view(&self) -> Option<&ViewId> {
        match self {
            Wanted::Nothing => None,
            Wanted::Placed(v, _) | Wanted::Parked(v) => Some(v),
        }
    }
}

impl Geometry {
    fn set_active(&mut self, seq: u64, session: &str, view: ViewId) -> bool {
        if !accept(&mut self.seqs.active, seq) {
            return false;
        }
        self.current = Some(view);
        self.session = session.to_string();
        true
    }

    fn set_bounds(&mut self, seq: u64, rect: Rect) -> bool {
        if !accept(&mut self.seqs.bounds, seq) {
            return false;
        }
        self.bounds = Rect {
            x: rect.x.round(),
            y: rect.y.round(),
            width: rect.width.round().max(0.0),
            height: rect.height.round().max(0.0),
        };
        true
    }

    fn set_flag(&mut self, seq: u64, flag: Flag, value: bool) -> bool {
        let (last, field) = match flag {
            Flag::Visible => (&mut self.seqs.visible, &mut self.visible),
            Flag::Overlay => (&mut self.seqs.overlay, &mut self.overlay),
            Flag::Occluded => (&mut self.seqs.occluded, &mut self.occluded),
        };
        if !accept(last, seq) {
            return false;
        }
        *field = value;
        true
    }

    fn shown(&self) -> bool {
        self.current.is_some() && self.visible && !self.overlay && !self.occluded && !self.bounds.is_empty()
    }

    fn wanted(&self) -> Wanted {
        match &self.current {
            None => Wanted::Nothing,
            Some(view) if self.shown() => Wanted::Placed(view.clone(), self.bounds),
            Some(view) => Wanted::Parked(view.clone()),
        }
    }
}

/// A snapshot for diagnostics and tests.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelStatus {
    pub current: Option<ViewId>,
    pub session: String,
    pub bounds: Rect,
    pub shown: bool,
    /// Reports dropped because a later one had already been applied.
    pub dropped: u64,
    /// `place` and `park` calls made on the views.
    pub applied: u64,
}

struct Inner {
    geometry: Mutex<Geometry>,
    counters: Mutex<(u64, u64)>,
    wake: Arc<Notify>,
    views: Arc<dyn BrowserViews>,
    listener: Mutex<Option<Arc<dyn PanelListener>>>,
}

impl Inner {
    fn geometry(&self) -> MutexGuard<'_, Geometry> {
        self.geometry.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn counters(&self) -> MutexGuard<'_, (u64, u64)> {
        self.counters.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn changed(&self, accepted: bool) {
        if accepted {
            self.wake.notify_one();
        } else {
            self.counters().0 += 1;
        }
    }
}

#[derive(Clone)]
pub struct Panel {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for Panel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Panel").field("status", &self.status()).finish()
    }
}

impl Panel {
    /// Starts the task that applies the wanted state on `rt`.
    pub fn new(views: Arc<dyn BrowserViews>, rt: &tokio::runtime::Handle) -> Self {
        let inner = Arc::new(Inner {
            geometry: Mutex::new(Geometry::default()),
            counters: Mutex::new((0, 0)),
            wake: Arc::new(Notify::new()),
            views,
            listener: Mutex::new(None),
        });
        rt.spawn(apply_loop(Arc::downgrade(&inner), inner.wake.clone()));
        Panel { inner }
    }

    pub fn set_listener(&self, listener: Arc<dyn PanelListener>) {
        *self.inner.listener.lock().unwrap_or_else(|p| p.into_inner()) = Some(listener);
    }

    /// The dashboard shows `view` (a tab of `session`) in the panel.
    pub fn set_active(&self, seq: u64, session: &str, view: ViewId) {
        let accepted = self.inner.geometry().set_active(seq, session, view.clone());
        self.inner.changed(accepted);
        if accepted {
            let listener = self.inner.listener.lock().unwrap_or_else(|p| p.into_inner()).clone();
            if let Some(listener) = listener {
                listener.active_view_changed(session, &view);
            }
        }
    }

    pub fn set_bounds(&self, seq: u64, rect: Rect) {
        let accepted = self.inner.geometry().set_bounds(seq, rect);
        self.inner.changed(accepted);
    }

    pub fn set_flag(&self, seq: u64, flag: Flag, value: bool) {
        let accepted = self.inner.geometry().set_flag(seq, flag, value);
        self.inner.changed(accepted);
    }

    /// The view was closed: it is no longer the panel's.
    pub fn forget(&self, view: &ViewId) {
        let mut geometry = self.inner.geometry();
        if geometry.current.as_ref() == Some(view) {
            geometry.current = None;
        }
    }

    /// The view on screen and its rectangle; `None` while nothing is shown.
    pub fn shown(&self) -> Option<(ViewId, Rect)> {
        match self.inner.geometry().wanted() {
            Wanted::Placed(view, rect) => Some((view, rect)),
            _ => None,
        }
    }

    pub fn status(&self) -> PanelStatus {
        let geometry = self.inner.geometry().clone();
        let (dropped, applied) = *self.inner.counters();
        PanelStatus {
            shown: geometry.shown(),
            current: geometry.current,
            session: geometry.session,
            bounds: geometry.bounds,
            dropped,
            applied,
        }
    }
}

/// Applies the latest wanted state, one native call at a time. Ends when the panel is gone.
async fn apply_loop(inner: std::sync::Weak<Inner>, wake: Arc<Notify>) {
    let mut applied = Wanted::Nothing;
    loop {
        let notified = wake.notified();
        let Some(strong) = inner.upgrade() else { return };
        let wanted = strong.geometry().wanted();
        if wanted != applied {
            // The view that was showing leaves the screen before another takes its place.
            if let Wanted::Placed(old, _) = &applied
                && wanted.view() != Some(old)
            {
                let _ = strong.views.park(old).await;
                let _ = strong.views.set_muted(old, true).await;
                strong.counters().1 += 1;
            }
            match &wanted {
                Wanted::Nothing => {}
                Wanted::Placed(view, rect) => {
                    let _ = strong.views.place(view, *rect).await;
                    let _ = strong.views.set_muted(view, false).await;
                    strong.counters().1 += 1;
                }
                Wanted::Parked(view) => {
                    let _ = strong.views.park(view).await;
                    // A view nobody can see is silent.
                    let _ = strong.views.set_muted(view, true).await;
                    strong.counters().1 += 1;
                }
            }
            applied = wanted;
            // Reports may have arrived meanwhile: look again before waiting.
            continue;
        }
        drop(strong);
        // Wakes for a new report, and now and then to notice the panel was dropped.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(30), notified).await;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use eos_core::BoxFuture;
    use eos_core::shell::{ViewError, ViewListener, ViewSpec};
    use serde_json::Value;

    use super::*;

    fn view(id: &str) -> ViewId {
        ViewId(id.to_string())
    }

    fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn a_stale_report_is_dropped_per_kind() {
        let mut g = Geometry::default();
        assert!(g.set_bounds(5, rect(1.0, 2.0, 300.0, 400.0)));
        assert!(!g.set_bounds(4, rect(9.0, 9.0, 9.0, 9.0)), "older than the last applied");
        assert_eq!(g.bounds, rect(1.0, 2.0, 300.0, 400.0));
        // Another kind has its own order.
        assert!(g.set_flag(3, Flag::Overlay, true));
        assert!(!g.set_flag(2, Flag::Overlay, false));
        assert!(g.overlay);
        assert!(g.set_flag(1, Flag::Occluded, true));
        // Equal and unordered (0) reports are applied.
        assert!(g.set_bounds(5, rect(0.0, 0.0, 10.0, 10.0)));
        assert!(g.set_bounds(0, rect(0.0, 0.0, 20.0, 20.0)));
        assert_eq!(g.bounds.width, 20.0);
    }

    #[test]
    fn bounds_are_rounded_and_never_negative() {
        let mut g = Geometry::default();
        g.set_bounds(1, rect(10.4, 20.6, -5.0, 99.5));
        assert_eq!(g.bounds, rect(10.0, 21.0, 0.0, 100.0));
    }

    #[test]
    fn shown_only_with_a_view_a_rectangle_and_nothing_over_it() {
        let mut g = Geometry::default();
        assert_eq!(g.wanted(), Wanted::Nothing);
        g.set_active(1, "s", view("a"));
        assert_eq!(g.wanted(), Wanted::Parked(view("a")), "no rectangle yet");
        g.set_bounds(1, rect(0.0, 0.0, 300.0, 200.0));
        assert_eq!(g.wanted(), Wanted::Placed(view("a"), rect(0.0, 0.0, 300.0, 200.0)));
        for flag in [Flag::Overlay, Flag::Occluded] {
            g.set_flag(0, flag, true);
            assert_eq!(g.wanted(), Wanted::Parked(view("a")));
            g.set_flag(0, flag, false);
        }
        g.set_flag(0, Flag::Visible, false);
        assert_eq!(g.wanted(), Wanted::Parked(view("a")));
    }

    #[derive(Default)]
    struct FakeViews {
        calls: Mutex<Vec<String>>,
    }

    impl FakeViews {
        fn log(&self, call: String) -> BoxFuture<'_, Result<(), ViewError>> {
            self.calls.lock().unwrap().push(call);
            Box::pin(async { Ok(()) })
        }
    }

    impl BrowserViews for FakeViews {
        fn create(&self, _spec: ViewSpec) -> BoxFuture<'_, Result<ViewId, ViewError>> {
            Box::pin(async { Ok(view("new")) })
        }
        fn close(&self, v: &ViewId) -> BoxFuture<'_, Result<(), ViewError>> {
            self.log(format!("close {v}"))
        }
        fn place(&self, v: &ViewId, r: Rect) -> BoxFuture<'_, Result<(), ViewError>> {
            self.log(format!("place {v} {},{} {}x{}", r.x, r.y, r.width, r.height))
        }
        fn park(&self, v: &ViewId) -> BoxFuture<'_, Result<(), ViewError>> {
            self.log(format!("park {v}"))
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

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    #[tokio::test]
    async fn the_view_follows_the_panel_and_the_old_one_is_parked() {
        let views = Arc::new(FakeViews::default());
        let panel = Panel::new(views.clone(), &tokio::runtime::Handle::current());
        panel.set_active(1, "s", view("a"));
        panel.set_bounds(2, rect(700.0, 60.0, 500.0, 600.0));
        settle().await;
        panel.set_flag(3, Flag::Overlay, true);
        settle().await;
        panel.set_flag(4, Flag::Overlay, false);
        settle().await;
        panel.set_active(5, "s", view("b"));
        settle().await;
        let calls = views.calls.lock().unwrap().clone();
        assert_eq!(calls.last().map(String::as_str), Some("place b 700,60 500x600"));
        let b_at = calls.iter().position(|c| c.starts_with("place b")).unwrap();
        assert!(calls[..b_at].iter().any(|c| c == "park a"), "{calls:?}");
        assert!(calls.contains(&"place a 700,60 500x600".to_string()), "{calls:?}");
        assert_eq!(panel.shown(), Some((view("b"), rect(700.0, 60.0, 500.0, 600.0))));
    }

    #[tokio::test]
    async fn a_burst_of_reports_lands_on_the_newest_rectangle() {
        let views = Arc::new(FakeViews::default());
        let panel = Panel::new(views.clone(), &tokio::runtime::Handle::current());
        panel.set_active(1, "s", view("a"));
        // Arrives out of order: 30 was sent last.
        for seq in [10u64, 30, 20, 25] {
            panel.set_bounds(seq, rect(seq as f64, 0.0, 100.0, 100.0));
        }
        settle().await;
        let calls = views.calls.lock().unwrap().clone();
        assert_eq!(calls.last().map(String::as_str), Some("place a 30,0 100x100"));
        let status = panel.status();
        assert_eq!(status.dropped, 2);
        assert!(status.applied <= 3, "coalesced: {calls:?}");
    }

    #[tokio::test]
    async fn the_listener_hears_about_the_active_tab() {
        struct Heard(Mutex<Vec<String>>);
        impl PanelListener for Heard {
            fn active_view_changed(&self, session: &str, view: &ViewId) {
                self.0.lock().unwrap().push(format!("{session}/{view}"));
            }
        }
        let panel = Panel::new(Arc::new(FakeViews::default()), &tokio::runtime::Handle::current());
        let heard = Arc::new(Heard(Mutex::new(Vec::new())));
        panel.set_listener(heard.clone());
        panel.set_active(2, "chat-1", view("t1"));
        panel.set_active(1, "chat-1", view("t0"));
        assert_eq!(*heard.0.lock().unwrap(), vec!["chat-1/t1".to_string()]);
        panel.forget(&view("t1"));
        assert_eq!(panel.status().current, None);
    }
}
