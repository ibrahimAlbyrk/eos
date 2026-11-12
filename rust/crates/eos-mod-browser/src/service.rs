//! The browser as the app runs it (`manager/modules/browser/BrowserService.ts`): one set of
//! tabs per session, started on first use, each on its own storage; what "this page" means
//! for a session; the tab list and status as events.
//!
//! A session is the root of an agent's parent chain, or the global one. Tabs are views of
//! the app's own window, so there is no browser process to supervise: a session's browser is
//! "running" once something used it.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};

use eos_contracts::{
    BrowserActRequest, BrowserActivity, BrowserDevice, BrowserElement, BrowserElementQuery, BrowserEngineState,
    BrowserFillFormRequest, BrowserFindResponse, BrowserGetRequest, BrowserGetRequestWhat, BrowserGetResponse,
    BrowserGetResponseWhat, BrowserNavigateRequest, BrowserNavigateRequestAction, BrowserPressRequest,
    BrowserScrollRequest, BrowserSnapshotRequest, BrowserSnapshotResponse, BrowserStatus, BrowserTab,
    BrowserTypeRequest, BrowserWaitRequest, BrowserWaitResponse, GLOBAL_SESSION,
};
use eos_core::shell::{PanelListener, ViewId};
use eos_core::store::ConfigSource;
use eos_core::{Clock, Sleeper};
use eos_runtime::bus::Bus;
use serde::Serialize;

use crate::driver::{Driver, DriverError, DriverEvents};
use crate::policy::{self, Actor};
use crate::{BROWSER_ACTIVITY, BROWSER_STATUS, BROWSER_TABS};

/// A new tab opens blank and stays there until someone gives it an address.
pub const NEW_TAB_URL: &str = "about:blank";

/// What the status names as the browser: the app's own embedded views. The value is the one
/// the app answers today.
const EMBEDDED_ENGINE: &str = "WebContentsView (embedded)";

const WAIT_POLL_MS: i64 = 250;

/// A second `browser_show` of one session within this window is dropped: the panel was just
/// brought up.
pub const PRESENT_RATE_LIMIT_MS: i64 = 3000;

/// How long tab changes a page causes (a title, an in-page navigation) are gathered before
/// the session's tab list is announced again.
const TABS_CHANGED_DEBOUNCE_MS: i64 = 250;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// 409: `browser.enabled` is off.
    #[error("browser subsystem is disabled")]
    Disabled,
    /// 403: the origin allowlist refused an agent's navigation.
    #[error("{0}")]
    NavBlocked(String),
    #[error(transparent)]
    Driver(#[from] DriverError),
}

type R<T> = Result<T, Error>;

fn failed(message: impl Into<String>) -> Error {
    Error::Driver(DriverError::Failed(message.into()))
}

/// The payload of `browser:tabs`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsChanged {
    pub session_id: String,
    pub tabs: Vec<BrowserTab>,
}

/// `{ ok: true }`, with a snapshot when one was asked for.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Acted {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<BrowserSnapshotResponse>,
}

#[derive(Default)]
struct State {
    /// Sessions whose browser something has used.
    launched: HashSet<String>,
    /// The size of each session's last announced tab list.
    tab_counts: HashMap<String, usize>,
    /// Per session, the tab an omitted `tabId` means: set when a tab is opened and by
    /// `browser_show`.
    active: HashMap<String, String>,
    /// Per session, the tab the dashboard's panel shows: what `active` falls back to.
    shown: HashMap<String, String>,
    last_present: HashMap<String, i64>,
    /// Sessions whose tab list is about to be announced.
    announcing: HashSet<String>,
}

pub struct BrowserService {
    me: Weak<BrowserService>,
    /// `None` without the app's window: the browser is absent.
    driver: Option<Arc<Driver>>,
    config: Arc<dyn ConfigSource>,
    bus: Bus,
    clock: Arc<dyn Clock>,
    sleeper: Arc<dyn Sleeper>,
    /// The runtime its own tasks run on, known from the first use of a browser: view events
    /// arrive on shell threads, and there are none before a tab exists.
    rt: OnceLock<tokio::runtime::Handle>,
    /// When this run started: names the storage of a run that keeps no profiles.
    run: i64,
    state: Mutex<State>,
    /// One announcement of a tab list at a time, so lists go out in the order they were read.
    announce: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for BrowserService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserService").field("window", &self.driver.is_some()).finish_non_exhaustive()
    }
}

impl BrowserService {
    pub(crate) fn new(
        driver: Option<Arc<Driver>>,
        config: Arc<dyn ConfigSource>,
        bus: Bus,
        clock: Arc<dyn Clock>,
        sleeper: Arc<dyn Sleeper>,
    ) -> Arc<Self> {
        let run = clock.now_ms();
        let service = Arc::new_cyclic(|me| BrowserService {
            me: me.clone(),
            driver,
            config,
            bus,
            clock,
            sleeper,
            rt: OnceLock::new(),
            run,
            state: Mutex::default(),
            announce: tokio::sync::Mutex::new(()),
        });
        if let Some(driver) = &service.driver {
            let events: Weak<dyn DriverEvents> = service.me.clone();
            driver.set_events(events);
        }
        service
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn settings(&self) -> eos_domain::config::Browser {
        self.config.current().browser.clone()
    }

    fn assert_enabled(&self) -> R<()> {
        if self.settings().enabled { Ok(()) } else { Err(Error::Disabled) }
    }

    fn driver(&self) -> R<&Arc<Driver>> {
        self.driver.as_ref().ok_or_else(|| failed("the browser needs the app's window, and there is none"))
    }

    /// The session whose browser a caller's session uses: its own, or the one shared
    /// browser when `browser.perSession` is off.
    pub fn resolve_session_key(&self, session: &str) -> String {
        if self.settings().per_session { session.to_owned() } else { GLOBAL_SESSION.to_owned() }
    }

    /// Whether each session has its own browser (`browser.perSession`).
    pub fn per_session(&self) -> bool {
        self.settings().per_session
    }

    /// The session a live tab belongs to; `None` for an unknown tab (which then answers 404,
    /// not 403).
    pub fn session_of_tab(&self, tab_id: &str) -> Option<String> {
        self.driver.as_ref()?.session_of(tab_id)
    }

    pub fn status(&self, session: &str) -> BrowserStatus {
        let key = self.resolve_session_key(session);
        let state = self.state();
        let running = self.driver.is_some() && state.launched.contains(&key);
        BrowserStatus {
            state: if !self.settings().enabled {
                BrowserEngineState::Disabled
            } else if self.driver.is_none() {
                BrowserEngineState::Absent
            } else if running {
                BrowserEngineState::Running
            } else {
                // Not started yet. There is no state for that; "launching" is what a
                // browser that is there but not yet used has always read as.
                BrowserEngineState::Launching
            },
            chrome_path: self.driver.as_ref().map(|_| EMBEDDED_ENGINE.to_owned()),
            tab_count: if running { state.tab_counts.get(&key).copied().unwrap_or(0).into() } else { 0.into() },
            session_id: Some(key),
        }
    }

    fn publish_status(&self, key: &str) {
        self.bus.publish(&BROWSER_STATUS, &self.status(key));
    }

    /// Starts the session's browser if nothing has used it yet.
    pub async fn ensure_launched(&self, session: &str) -> R<()> {
        self.assert_enabled()?;
        self.driver()?;
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let _ = self.rt.set(rt);
        }
        let key = self.resolve_session_key(session);
        if self.state().launched.insert(key.clone()) {
            self.publish_status(&key);
        }
        Ok(())
    }

    fn profile(&self, key: &str) -> String {
        policy::profile_name(key, (!self.settings().persist_profile).then_some(self.run))
    }

    pub async fn open_tab(&self, url: Option<&str>, actor: Actor, session: &str) -> R<String> {
        self.ensure_launched(session).await?;
        let url = url.unwrap_or(NEW_TAB_URL);
        policy::check_navigation(url, actor, &self.settings().allowed_origins).map_err(Error::NavBlocked)?;
        let key = self.resolve_session_key(session);
        let tab_id = self.driver()?.open_tab(&key, &self.profile(&key), url, true).await?;
        self.state().active.insert(key.clone(), tab_id.clone());
        self.publish_tabs(&key).await;
        Ok(tab_id)
    }

    pub async fn close_tab(&self, tab_id: &str) -> R<()> {
        self.assert_enabled()?;
        let key = self.owner(tab_id)?;
        self.driver()?.close_tab(tab_id).await;
        {
            let mut state = self.state();
            if state.active.get(&key).is_some_and(|active| active == tab_id) {
                state.active.remove(&key);
            }
        }
        self.publish_tabs(&key).await;
        Ok(())
    }

    /// The session of a tab a verb names, or the unknown-tab error.
    fn owner(&self, tab_id: &str) -> R<String> {
        self.session_of_tab(tab_id).ok_or_else(|| Error::Driver(DriverError::UnknownTab(tab_id.to_owned())))
    }

    pub async fn list_tabs(&self, session: &str) -> R<Vec<BrowserTab>> {
        self.assert_enabled()?;
        let key = self.resolve_session_key(session);
        let Some(driver) = self.driver.as_ref().filter(|_| self.state().launched.contains(&key)) else {
            return Ok(Vec::new());
        };
        let tabs = driver.list_tabs(&key).await;
        Ok(tabs
            .into_iter()
            .map(|tab| BrowserTab {
                tab_id: tab.tab_id,
                session_id: key.clone(),
                url: tab.url,
                title: tab.title,
                loading: tab.loading,
                can_go_back: tab.can_go_back,
                can_go_forward: tab.can_go_forward,
                audible: tab.audible,
                muted: tab.muted,
                // Favicons are not resolved for embedded views: `null`, as today.
                favicon_data_uri: Some(None),
            })
            .collect())
    }

    /// The session's "this page": where an omitted `tabId` goes. The explicit pointer first,
    /// then the tab the panel shows, each only while it is a live tab of that session.
    /// `None` when neither is: acting on a tab nobody expected is worse than failing.
    pub fn active_tab_id(&self, session: &str) -> R<Option<String>> {
        self.assert_enabled()?;
        let key = self.resolve_session_key(session);
        let state = self.state();
        let live = |tab: Option<&String>| tab.filter(|tab| self.session_of_tab(tab).as_deref() == Some(&key)).cloned();
        Ok(live(state.active.get(&key)).or_else(|| live(state.shown.get(&key))))
    }

    /// Records the session's "look here" pointer.
    pub fn set_active_tab(&self, session: &str, tab_id: &str) {
        let key = self.resolve_session_key(session);
        self.state().active.insert(key, tab_id.to_owned());
    }

    /// Whether a present may go out now; a yes starts the session's next quiet window.
    pub fn present_allowed(&self, session: &str) -> bool {
        let key = self.resolve_session_key(session);
        let now = self.clock.now_ms();
        let mut state = self.state();
        if state.last_present.get(&key).is_some_and(|last| now - last < PRESENT_RATE_LIMIT_MS) {
            return false;
        }
        state.last_present.insert(key, now);
        true
    }

    /// Announces that an agent used or presented a tab.
    pub fn publish_activity(&self, activity: BrowserActivity) {
        let session_id = self.resolve_session_key(&activity.session_id);
        self.bus.publish(&BROWSER_ACTIVITY, &BrowserActivity { session_id, ..activity });
    }

    pub async fn navigate(&self, tab_id: &str, request: &BrowserNavigateRequest, actor: Actor) -> R<()> {
        self.assert_enabled()?;
        // The rule before the tab: a refused address reads as 403 also on an unknown tab.
        if request.action == BrowserNavigateRequestAction::Url {
            let url = request.url.as_deref().filter(|u| !u.is_empty());
            let url = url.ok_or_else(|| failed("navigate action 'url' requires a url"))?;
            policy::check_navigation(url, actor, &self.settings().allowed_origins).map_err(Error::NavBlocked)?;
        }
        let key = self.owner(tab_id)?;
        self.driver()?.navigate(tab_id, request.action, request.url.as_deref()).await?;
        self.publish_tabs(&key).await;
        Ok(())
    }

    // ---- what agents do on a page ---------------------------------------------------------

    pub async fn snapshot(&self, tab_id: &str, request: &BrowserSnapshotRequest) -> R<BrowserSnapshotResponse> {
        self.assert_enabled()?;
        self.owner(tab_id)?;
        let depth = request.depth.and_then(|d| u64::try_from(d).ok());
        let (url, snapshot) =
            self.driver()?.snapshot(tab_id, request.interactive_only, request.selector.as_deref(), depth).await?;
        Ok(BrowserSnapshotResponse { tab_id: tab_id.to_owned(), url, snapshot })
    }

    pub async fn find(&self, tab_id: &str, query: &str) -> R<BrowserFindResponse> {
        self.assert_enabled()?;
        self.owner(tab_id)?;
        let driver = self.driver()?;
        let matches = driver.find(tab_id, query).await?;
        Ok(BrowserFindResponse { tab_id: tab_id.to_owned(), url: driver.url(tab_id).await?, matches })
    }

    async fn acted(&self, tab_id: &str, include_snapshot: bool) -> R<Acted> {
        let snapshot = if include_snapshot {
            let request = BrowserSnapshotRequest { tab_id: None, interactive_only: true, selector: None, depth: None };
            Some(self.snapshot(tab_id, &request).await?)
        } else {
            None
        };
        Ok(Acted { ok: true, snapshot })
    }

    pub async fn act(&self, tab_id: &str, request: &BrowserActRequest) -> R<Acted> {
        self.assert_enabled()?;
        self.owner(tab_id)?;
        self.driver()?.act(tab_id, &request.r#ref, request.verb).await?;
        self.acted(tab_id, request.include_snapshot).await
    }

    pub async fn type_text(&self, tab_id: &str, request: &BrowserTypeRequest) -> R<Acted> {
        self.assert_enabled()?;
        self.owner(tab_id)?;
        self.driver()?.type_text(tab_id, &request.r#ref, &request.text, request.submit).await?;
        self.acted(tab_id, request.include_snapshot).await
    }

    pub async fn fill_form(&self, tab_id: &str, request: &BrowserFillFormRequest) -> R<Acted> {
        self.assert_enabled()?;
        self.owner(tab_id)?;
        let driver = self.driver()?;
        for field in &request.fields {
            driver.type_text(tab_id, &field.r#ref, &field.value, false).await?;
        }
        Ok(Acted { ok: true, snapshot: None })
    }

    pub async fn press(&self, tab_id: &str, request: &BrowserPressRequest) -> R<Acted> {
        self.assert_enabled()?;
        self.owner(tab_id)?;
        self.driver()?.press(tab_id, &request.key).await?;
        Ok(Acted { ok: true, snapshot: None })
    }

    pub async fn scroll(&self, tab_id: &str, request: &BrowserScrollRequest) -> R<Acted> {
        self.assert_enabled()?;
        self.owner(tab_id)?;
        self.driver()?.scroll(tab_id, request.direction, request.r#ref.as_deref()).await?;
        Ok(Acted { ok: true, snapshot: None })
    }

    pub async fn get(&self, tab_id: &str, request: &BrowserGetRequest) -> R<BrowserGetResponse> {
        self.assert_enabled()?;
        self.owner(tab_id)?;
        let value = self.driver()?.get(tab_id, request.what, request.r#ref.as_deref()).await?;
        let what = match request.what {
            BrowserGetRequestWhat::Text => BrowserGetResponseWhat::Text,
            BrowserGetRequestWhat::Url => BrowserGetResponseWhat::Url,
            BrowserGetRequestWhat::Title => BrowserGetResponseWhat::Title,
            BrowserGetRequestWhat::Value => BrowserGetResponseWhat::Value,
        };
        Ok(BrowserGetResponse { tab_id: tab_id.to_owned(), what, value })
    }

    /// The JPEG of a capture. The caller writes it where an agent can read it: bytes never
    /// travel as a tool's answer.
    pub async fn capture(&self, tab_id: &str, full_page: bool) -> R<Vec<u8>> {
        self.assert_enabled()?;
        self.owner(tab_id)?;
        Ok(self.driver()?.capture(tab_id, full_page).await?)
    }

    pub async fn set_device(&self, tab_id: &str, device: BrowserDevice) -> R<Acted> {
        self.assert_enabled()?;
        let key = self.owner(tab_id)?;
        self.driver()?.set_device(tab_id, device).await?;
        self.publish_tabs(&key).await;
        Ok(Acted { ok: true, snapshot: None })
    }

    pub async fn element_at(&self, tab_id: &str, query: &BrowserElementQuery) -> R<BrowserElement> {
        self.assert_enabled()?;
        let (x, y) = query
            .at
            .or(query.hover)
            .ok_or_else(|| failed("elements query requires { at:[x,y] } or { hover:[x,y] }"))?;
        self.owner(tab_id)?;
        Ok(self.driver()?.element_at(tab_id, x.as_f64(), y.as_f64()).await?)
    }

    pub async fn wait(&self, tab_id: &str, request: &BrowserWaitRequest) -> R<BrowserWaitResponse> {
        self.assert_enabled()?;
        self.owner(tab_id)?;
        let driver = self.driver()?;
        let started = self.clock.now_ms();
        let deadline = started + request.timeout_ms;
        let answer =
            |ok: bool, now: i64| BrowserWaitResponse { ok, timed_out: !ok, elapsed_ms: (now - started).into() };
        if let Some(ms) = request.for_ms {
            self.sleeper.sleep(ms.min(request.timeout_ms)).await;
            return Ok(answer(true, self.clock.now_ms()));
        }
        if request.for_text.is_none() && request.for_ref.is_none() {
            return Err(failed("wait requires forText, forRef, or forMs"));
        }
        loop {
            let hit = match (&request.for_text, &request.for_ref) {
                (Some(text), _) => driver.text_present(tab_id, text).await?,
                // A ref that is gone is just not visible yet.
                (None, Some(reference)) => driver.ref_visible(tab_id, reference).await.unwrap_or(false),
                (None, None) => false,
            };
            let now = self.clock.now_ms();
            if hit {
                return Ok(answer(true, now));
            }
            if now + WAIT_POLL_MS > deadline {
                return Ok(answer(false, now));
            }
            self.sleeper.sleep(WAIT_POLL_MS).await;
        }
    }

    pub async fn set_muted(&self, tab_id: &str, muted: bool) -> R<Acted> {
        self.assert_enabled()?;
        let key = self.owner(tab_id)?;
        self.driver()?.set_muted(tab_id, muted).await?;
        self.publish_tabs(&key).await;
        Ok(Acted { ok: true, snapshot: None })
    }

    /// Lets the user pick an element of the tab on the live view.
    pub async fn pick_element(&self, tab_id: &str) -> Option<BrowserElement> {
        if !self.settings().enabled {
            return None;
        }
        self.driver.as_ref()?.pick_element(tab_id).await
    }

    pub fn cancel_pick(&self) {
        if let Some(driver) = &self.driver {
            driver.cancel_pick();
        }
    }

    // ---- ending ------------------------------------------------------------------------

    fn forget_session(&self, key: &str) {
        let mut state = self.state();
        state.launched.remove(key);
        state.tab_counts.remove(key);
        state.active.remove(key);
        state.shown.remove(key);
        state.last_present.remove(key);
    }

    /// [`dispose_session`](Self::dispose_session) from a thread that cannot wait. A session
    /// whose browser was never used has nothing to close.
    pub fn end_session(&self, session: &str) {
        let (Some(me), Some(rt), session) = (self.me.upgrade(), self.rt.get(), session.to_owned()) else { return };
        rt.spawn(async move { me.dispose_session(&session).await });
    }

    /// Closes one session's tabs (its root chat was killed, archived or removed). Its
    /// storage stays: the next use finds the logins. Nothing happens while every session
    /// shares one browser.
    pub async fn dispose_session(&self, session: &str) {
        if !self.settings().per_session || !self.state().launched.contains(session) {
            return;
        }
        if let Some(driver) = &self.driver {
            driver.dispose_session(session).await;
        }
        self.forget_session(session);
        self.publish_status(session);
        self.bus.publish(&BROWSER_TABS, &TabsChanged { session_id: session.to_owned(), tabs: Vec::new() });
    }

    /// Closes every tab: the app is quitting.
    pub async fn dispose(&self) {
        let sessions: Vec<String> = self.state().launched.iter().cloned().collect();
        for session in sessions {
            if let Some(driver) = &self.driver {
                driver.dispose_session(&session).await;
            }
            self.forget_session(&session);
        }
    }

    // ---- announcing the tab list ---------------------------------------------------------

    async fn publish_tabs(&self, key: &str) {
        let _one_at_a_time = self.announce.lock().await;
        match self.list_tabs(key).await {
            Ok(tabs) => {
                self.state().tab_counts.insert(key.to_owned(), tabs.len());
                self.bus.publish(&BROWSER_TABS, &TabsChanged { session_id: key.to_owned(), tabs });
            }
            Err(error) => tracing::warn!(%error, "browser tab publish failed"),
        }
    }

    /// Announces the session's tabs once the changes a page is causing have settled.
    fn schedule_publish_tabs(&self, key: &str) {
        if !self.state().announcing.insert(key.to_owned()) {
            return;
        }
        let (Some(me), Some(rt), key) = (self.me.upgrade(), self.rt.get(), key.to_owned()) else { return };
        rt.spawn(async move {
            me.sleeper.sleep(TABS_CHANGED_DEBOUNCE_MS).await;
            me.state().announcing.remove(&key);
            me.publish_tabs(&key).await;
        });
    }
}

impl DriverEvents for BrowserService {
    fn tabs_changed(&self, session: &str) {
        self.schedule_publish_tabs(session);
    }

    fn popup(&self, session: &str, url: String) {
        let (Some(me), Some(rt), session) = (self.me.upgrade(), self.rt.get(), session.to_owned()) else { return };
        rt.spawn(async move {
            let Some(driver) = &me.driver else { return };
            // A page's own popup: a tab of the same session, never asked for by anyone.
            match driver.open_tab(&session, &me.profile(&session), &url, false).await {
                Ok(_) => me.publish_tabs(&session).await,
                Err(error) => tracing::warn!(%error, "a page's popup did not become a tab"),
            }
        });
    }

    fn tab_gone(&self, session: &str, tab_id: &str) {
        {
            let mut state = self.state();
            if state.active.get(session).is_some_and(|active| active == tab_id) {
                state.active.remove(session);
            }
        }
        self.schedule_publish_tabs(session);
    }
}

impl PanelListener for BrowserService {
    fn active_view_changed(&self, session: &str, view: &ViewId) {
        let key = self.resolve_session_key(session);
        self.state().shown.insert(key, view.0.clone());
    }
}
