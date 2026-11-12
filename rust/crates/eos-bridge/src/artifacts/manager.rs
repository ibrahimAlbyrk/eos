//! The pool of artifact views and their places (`ArtifactViewHost.ts`, `placement.ts`,
//! `viewEvents.ts`, `capture.ts`). One task owns every view and applies each command in
//! the order it came, so a view's calls on the surface never overtake each other.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use eos_core::shell::Rect;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

use super::pool::{IDLE, POOL_CAP, PoolItem, pick_evictions};
use super::stills::StillStore;
use super::urls::{Viewer, is_web};
use super::{ArtifactRef, ArtifactSurface, SurfaceEvent, ViewKey, ViewState, profile_for};

/// Tells the dashboard something: an event name and its payload.
pub type Emit = Arc<dyn Fn(&'static str, Value) + Send + Sync>;

/// A hidden view keeps a real size, so its page has a layout viewport to load and be
/// captured at.
const HIDDEN_SIZE: (f64, f64) = (1280.0, 800.0);
const PEEK_RADIUS: f64 = 10.0;
const TAB_RADIUS: f64 = 9.0;
/// A page that reached its DOM but whose load never ends is shown after this.
const LOAD_TIMEOUT: Duration = Duration::from_secs(30);
/// After the load event, for the page's own first paint.
const READY_DELAY: Duration = Duration::from_millis(600);
/// After a view is ready, before its still is taken.
const STILL_SETTLE: Duration = Duration::from_millis(1500);
const TRIM_EVERY: Duration = Duration::from_secs(60);
/// Commands waiting for the task; a full queue makes the dashboard's calls wait.
const QUEUE: usize = 256;
/// How long the email of a signed-in profile is kept, and how long a failed lookup is.
const EMAIL_KEPT: Duration = Duration::from_secs(10 * 60);
const EMAIL_RETRY: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq)]
struct TabPlace {
    tab_key: String,
    rect: Rect,
    visible: bool,
}

#[derive(Debug, Clone, PartialEq)]
enum Placement {
    None,
    /// The peek remembers the tab it took the view from, and hands it back on unpeek.
    Peek {
        rect: Rect,
        from: Option<TabPlace>,
    },
    Tab(TabPlace),
}

/// What the surface was last told about a view's place.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Shown {
    At(Rect, f64),
    Hidden((f64, f64)),
}

struct Entry {
    slug: String,
    artifact: ArtifactRef,
    profile: String,
    state: ViewState,
    error: Option<String>,
    placement: Placement,
    last_used: Instant,
    shown: Shown,
    peek: bool,
    muted: Option<bool>,
    /// Bumps per load: a timer or a capture of an older load sees it moved on.
    seq: u64,
    loaded_version: Option<String>,
    /// The load whose document reached its DOM.
    dom_seq: Option<u64>,
    /// This load's still is not taken yet: a hidden page keeps running until it is.
    capturing: bool,
    /// This load was a reload: its still is taken again.
    recapture: bool,
    /// The surface was told to throttle the page.
    throttled: bool,
    still_due: bool,
    /// A reload of a ready view loads off screen in `next`, which takes its place once ready.
    next: Option<ViewKey>,
    replaces: Option<ViewKey>,
}

impl Entry {
    fn on_screen(&self) -> bool {
        matches!(self.shown, Shown::At(..))
    }
}

pub(super) enum Timer {
    LoadTimeout,
    Ready,
    StillSettle,
}

pub(super) enum Command {
    Warm(ArtifactRef),
    Peek(ArtifactRef, Rect),
    Unpeek,
    Attach(String, ArtifactRef, Rect),
    SetBounds(String, Rect),
    SetVisible(String, bool),
    Detach(String),
    Reload(String),
    State(String, oneshot::Sender<ViewState>),
    Covered(bool),
    SignedIn(String),
    SignedOut(String),
    Surface(ViewKey, SurfaceEvent),
    Checked { key: ViewKey, seq: u64, signed_in: bool },
    Timer { key: ViewKey, seq: u64, timer: Timer },
    StillTaken { key: ViewKey, seq: u64, jpeg: Option<Vec<u8>> },
    Status(oneshot::Sender<Value>),
}

/// The dashboard's handle on the artifact views. Cheap to clone.
#[derive(Clone)]
pub struct ArtifactViews {
    tx: mpsc::Sender<Command>,
    surface: Arc<dyn ArtifactSurface>,
    stills: StillStore,
    emails: Arc<std::sync::Mutex<Emails>>,
}

/// The email each profile is signed in as (`None`: the site did not say), and when it was
/// read: one entry per sign-in.
type Emails = HashMap<String, (Option<String>, Instant)>;

/// The account's email in the site's account document (`email_address`, else `email`).
fn email_of(account: &Value) -> Option<String> {
    let email = account.get("email_address").or_else(|| account.get("email"))?.as_str()?;
    email.contains('@').then(|| email.to_owned())
}

impl std::fmt::Debug for ArtifactViews {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ArtifactViews").finish_non_exhaustive()
    }
}

impl ArtifactViews {
    /// Starts the task that owns the views, on `rt`.
    pub fn start(
        surface: Arc<dyn ArtifactSurface>,
        viewer: Viewer,
        stills: StillStore,
        emit: Emit,
        rt: &tokio::runtime::Handle,
    ) -> Self {
        let (tx, rx) = mpsc::channel(QUEUE);
        let pool = Pool {
            surface: surface.clone(),
            viewer,
            stills: stills.clone(),
            emit,
            tx: tx.downgrade(),
            rt: rt.clone(),
            entries: HashMap::new(),
            by_slug: HashMap::new(),
            peeked: None,
            next_key: 1,
            covered: false,
        };
        rt.spawn(pool.run(rx));
        Self { tx, surface, stills, emails: Arc::default() }
    }

    async fn send(&self, command: Command) {
        let _ = self.tx.send(command).await;
    }

    /// Keeps a live view of the artifact loading off screen.
    pub async fn warm(&self, artifact: ArtifactRef) {
        self.send(Command::Warm(artifact)).await;
    }

    pub async fn peek(&self, artifact: ArtifactRef, rect: Rect) {
        self.send(Command::Peek(artifact, rect)).await;
    }

    pub async fn unpeek(&self) {
        self.send(Command::Unpeek).await;
    }

    /// The side-panel tab `tab_key` shows the artifact at `rect`.
    pub async fn attach(&self, tab_key: String, artifact: ArtifactRef, rect: Rect) {
        self.send(Command::Attach(tab_key, artifact, rect)).await;
    }

    pub async fn set_bounds(&self, tab_key: String, rect: Rect) {
        self.send(Command::SetBounds(tab_key, rect)).await;
    }

    pub async fn set_visible(&self, tab_key: String, visible: bool) {
        self.send(Command::SetVisible(tab_key, visible)).await;
    }

    pub async fn detach(&self, tab_key: String) {
        self.send(Command::Detach(tab_key)).await;
    }

    pub async fn reload(&self, slug: String) {
        self.send(Command::Reload(slug)).await;
    }

    /// Another computer's view covers the dashboard: every artifact view stays hidden.
    pub async fn set_covered(&self, covered: bool) {
        self.send(Command::Covered(covered)).await;
    }

    pub async fn state(&self, slug: String) -> ViewState {
        let (tx, rx) = oneshot::channel();
        self.send(Command::State(slug, tx)).await;
        rx.await.unwrap_or(ViewState::Idle)
    }

    /// The artifact's last still as a `data:` URL.
    pub async fn still(&self, artifact: ArtifactRef) -> Option<String> {
        let stills = self.stills.clone();
        tokio::task::spawn_blocking(move || stills.read(&artifact.slug, artifact.version.as_deref()))
            .await
            .ok()
            .flatten()
    }

    /// Whether the sign-in's profile holds a claude.ai sign-in, and as whom when the site
    /// says: `{signedIn, email?}`.
    pub async fn account(&self, login_id: Option<String>) -> Value {
        let profile = profile_for(login_id.as_deref());
        if !self.surface.signed_in(&profile).await {
            return json!({ "signedIn": false });
        }
        match self.email(&profile).await {
            Some(email) => json!({ "signedIn": true, "email": email }),
            None => json!({ "signedIn": true }),
        }
    }

    async fn email(&self, profile: &str) -> Option<String> {
        let now = Instant::now();
        let kept = self.emails.lock().unwrap_or_else(|p| p.into_inner()).get(profile).cloned();
        if let Some((email, at)) = kept
            && now.saturating_duration_since(at) < if email.is_some() { EMAIL_KEPT } else { EMAIL_RETRY }
        {
            return email;
        }
        let email = self.surface.account(profile).await.as_ref().and_then(email_of);
        self.emails.lock().unwrap_or_else(|p| p.into_inner()).insert(profile.to_owned(), (email.clone(), now));
        email
    }

    fn forget_email(&self, profile: &str) {
        self.emails.lock().unwrap_or_else(|p| p.into_inner()).remove(profile);
    }

    /// Opens the site's sign-in for the sign-in's profile; views waiting for it load once
    /// it is done.
    pub async fn sign_in(&self, login_id: Option<String>) -> Value {
        let profile = profile_for(login_id.as_deref());
        if self.surface.sign_in(&profile).await {
            self.forget_email(&profile);
            self.send(Command::SignedIn(profile.clone())).await;
        }
        self.account(login_id).await
    }

    pub async fn sign_out(&self, login_id: Option<String>) {
        let profile = profile_for(login_id.as_deref());
        self.surface.sign_out(&profile).await;
        self.forget_email(&profile);
        self.send(Command::SignedOut(profile)).await;
    }

    /// What a view's page did. Called on a shell thread: never waits.
    pub fn surface_event(&self, view: ViewKey, event: SurfaceEvent) {
        if self.tx.try_send(Command::Surface(view, event)).is_err() {
            tracing::warn!(target: "eos::artifacts", "a view event was dropped: the queue is full");
        }
    }

    /// For diagnostics and the smoke run: the views' states and places, no slugs.
    pub async fn status(&self) -> Value {
        let (tx, rx) = oneshot::channel();
        self.send(Command::Status(tx)).await;
        rx.await.unwrap_or(Value::Null)
    }
}

struct Pool {
    surface: Arc<dyn ArtifactSurface>,
    viewer: Viewer,
    stills: StillStore,
    emit: Emit,
    /// For timers and finished side work: weak, so the task ends with the last handle.
    tx: mpsc::WeakSender<Command>,
    rt: tokio::runtime::Handle,
    entries: HashMap<ViewKey, Entry>,
    /// The view the dashboard sees for each artifact (a replacement still loading is not).
    by_slug: HashMap<String, ViewKey>,
    peeked: Option<ViewKey>,
    next_key: ViewKey,
    covered: bool,
}

impl Pool {
    async fn run(mut self, mut rx: mpsc::Receiver<Command>) {
        let mut trim = tokio::time::interval_at(Instant::now() + TRIM_EVERY, TRIM_EVERY);
        loop {
            tokio::select! {
                command = rx.recv() => match command {
                    Some(command) => self.handle(command).await,
                    None => break,
                },
                _ = trim.tick() => self.trim(None).await,
            }
        }
        for key in self.entries.keys().copied().collect::<Vec<_>>() {
            self.dispose(key, false).await;
        }
    }

    async fn handle(&mut self, command: Command) {
        match command {
            Command::Warm(artifact) => {
                if let Some(key) = self.ensure(artifact).await {
                    self.trim(Some(key)).await;
                }
            }
            Command::Peek(artifact, rect) => self.peek(artifact, rect).await,
            Command::Unpeek => {
                if let Some(key) = self.peeked {
                    self.end_peek(key).await;
                    self.trim(None).await;
                }
            }
            Command::Attach(tab_key, artifact, rect) => self.attach(tab_key, artifact, rect).await,
            Command::SetBounds(tab_key, rect) => {
                if let Some(key) = self.with_tab(&tab_key, |tab| tab.rect = rect) {
                    self.apply(key).await;
                }
            }
            Command::SetVisible(tab_key, visible) => {
                if let Some(key) = self.with_tab(&tab_key, |tab| tab.visible = visible) {
                    if visible && let Some(e) = self.entries.get_mut(&key) {
                        e.last_used = Instant::now();
                    }
                    self.apply(key).await;
                }
            }
            Command::Detach(tab_key) => self.detach(&tab_key).await,
            Command::Reload(slug) => {
                if let Some(&key) = self.by_slug.get(&slug) {
                    if let Some(e) = self.entries.get_mut(&key) {
                        e.last_used = Instant::now();
                    }
                    self.refresh(key).await;
                }
            }
            Command::State(slug, reply) => {
                let state =
                    self.by_slug.get(&slug).and_then(|k| self.entries.get(k)).map_or(ViewState::Idle, |e| e.state);
                let _ = reply.send(state);
            }
            Command::Covered(covered) => {
                self.covered = covered;
                for key in self.entries.keys().copied().collect::<Vec<_>>() {
                    self.apply(key).await;
                }
            }
            Command::SignedIn(profile) => {
                let waiting: Vec<ViewKey> = self
                    .entries
                    .iter()
                    .filter(|(_, e)| e.profile == profile && e.state == ViewState::Signin)
                    .map(|(k, _)| *k)
                    .collect();
                for key in waiting {
                    self.load(key, false);
                }
            }
            Command::SignedOut(profile) => self.signed_out(&profile).await,
            Command::Surface(key, event) => self.surface_event(key, event).await,
            Command::Checked { key, seq, signed_in } => self.checked(key, seq, signed_in).await,
            Command::Timer { key, seq, timer } => self.timer(key, seq, timer).await,
            Command::StillTaken { key, seq, jpeg } => self.still_taken(key, seq, jpeg).await,
            Command::Status(reply) => {
                let views: Vec<Value> = self
                    .entries
                    .values()
                    .map(|e| {
                        let place = match &e.placement {
                            Placement::None => "none",
                            Placement::Peek { .. } => "peek",
                            Placement::Tab(_) => "tab",
                        };
                        json!({ "state": e.state.name(), "place": place, "shown": e.on_screen(), "replacing": e.replaces.is_some() })
                    })
                    .collect();
                let _ = reply.send(json!({ "views": views }));
            }
        }
    }

    // ---- the dashboard's verbs ------------------------------------------------------

    async fn peek(&mut self, artifact: ArtifactRef, rect: Rect) {
        let Some(key) = self.ensure(artifact).await else { return };
        if let Some(other) = self.peeked.filter(|p| *p != key) {
            self.end_peek(other).await;
        }
        let Some(e) = self.entries.get_mut(&key) else { return };
        let from = match std::mem::replace(&mut e.placement, Placement::None) {
            Placement::Tab(tab) => Some(tab),
            Placement::Peek { from, .. } => from,
            Placement::None => None,
        };
        e.placement = Placement::Peek { rect, from };
        self.peeked = Some(key);
        self.apply(key).await;
        self.trim(Some(key)).await;
    }

    async fn attach(&mut self, tab_key: String, artifact: ArtifactRef, rect: Rect) {
        let Some(key) = self.ensure(artifact).await else { return };
        let mut unplace = Vec::new();
        for (other, e) in &mut self.entries {
            if *other == key {
                continue;
            }
            match &mut e.placement {
                Placement::Tab(tab) if tab.tab_key == tab_key => unplace.push(*other),
                Placement::Peek { from, .. } if from.as_ref().is_some_and(|t| t.tab_key == tab_key) => *from = None,
                _ => {}
            }
        }
        for other in unplace {
            self.unplace(other).await;
        }
        if self.peeked == Some(key) {
            self.peeked = None;
        }
        let Some(e) = self.entries.get_mut(&key) else { return };
        let was_peek = matches!(e.placement, Placement::Peek { .. });
        e.placement = Placement::Tab(TabPlace { tab_key, rect, visible: true });
        let still_due = was_peek && e.still_due;
        self.apply(key).await;
        if still_due {
            self.schedule_still(key);
        }
        self.trim(Some(key)).await;
    }

    async fn detach(&mut self, tab_key: &str) {
        let Some(key) = self.tab_holder(tab_key) else { return };
        let Some(e) = self.entries.get_mut(&key) else { return };
        if let Placement::Peek { from, .. } = &mut e.placement {
            *from = None;
        } else {
            self.unplace(key).await;
        }
        self.trim(None).await;
    }

    fn tab_holder(&self, tab_key: &str) -> Option<ViewKey> {
        self.entries.iter().find_map(|(key, e)| {
            let holds = match &e.placement {
                Placement::Tab(tab) => tab.tab_key == tab_key,
                Placement::Peek { from, .. } => from.as_ref().is_some_and(|t| t.tab_key == tab_key),
                Placement::None => false,
            };
            holds.then_some(*key)
        })
    }

    /// Changes the tab place `tab_key` names, wherever it is held.
    fn with_tab(&mut self, tab_key: &str, change: impl FnOnce(&mut TabPlace)) -> Option<ViewKey> {
        let key = self.tab_holder(tab_key)?;
        let e = self.entries.get_mut(&key)?;
        match &mut e.placement {
            Placement::Tab(tab) => change(tab),
            Placement::Peek { from: Some(tab), .. } => change(tab),
            _ => return None,
        }
        Some(key)
    }

    // ---- the pool -------------------------------------------------------------------

    async fn ensure(&mut self, artifact: ArtifactRef) -> Option<ViewKey> {
        let profile = profile_for(artifact.login_id.as_deref());
        let existing = self.by_slug.get(&artifact.slug).copied();
        let key = match existing {
            Some(key) if self.entries.get(&key).is_some_and(|e| e.profile == profile) => {
                let wanted = artifact.version.clone();
                let e = self.entries.get_mut(&key)?;
                e.artifact.login_id = artifact.login_id;
                if wanted.is_some() {
                    e.artifact.version = wanted.clone();
                }
                let (next, own) = (e.next, e.loaded_version.clone());
                let loaded = next.and_then(|n| self.entries.get(&n)).and_then(|n| n.loaded_version.clone()).or(own);
                // A newer version was published since this view (or its replacement) loaded.
                if let (Some(wanted), Some(loaded)) = (wanted, loaded)
                    && wanted != loaded
                {
                    self.refresh(key).await;
                }
                key
            }
            Some(old) => self.recreate(old, artifact, profile).await?,
            None => self.create(artifact, profile).await?,
        };
        if let Some(e) = self.entries.get_mut(&key) {
            e.last_used = Instant::now();
        }
        Some(key)
    }

    /// A hidden view, not yet the artifact's.
    async fn build(&mut self, artifact: ArtifactRef, profile: String) -> Option<ViewKey> {
        let key = self.next_key;
        self.next_key += 1;
        if let Err(e) = self.surface.create(key, &profile).await {
            tracing::warn!(target: "eos::artifacts", error = %e, "no view for an artifact");
            return None;
        }
        self.surface.set_muted(key, true).await;
        let slug = artifact.slug.clone();
        self.entries.insert(
            key,
            Entry {
                slug,
                artifact,
                profile,
                state: ViewState::Idle,
                error: None,
                placement: Placement::None,
                last_used: Instant::now(),
                // The surface creates a view parked at the hidden size.
                shown: Shown::Hidden(HIDDEN_SIZE),
                peek: false,
                muted: Some(true),
                seq: 0,
                loaded_version: None,
                dom_seq: None,
                capturing: false,
                recapture: false,
                throttled: false,
                still_due: false,
                next: None,
                replaces: None,
            },
        );
        Some(key)
    }

    async fn create(&mut self, artifact: ArtifactRef, profile: String) -> Option<ViewKey> {
        let slug = artifact.slug.clone();
        let key = self.build(artifact, profile).await?;
        self.by_slug.insert(slug, key);
        self.load(key, false);
        Some(key)
    }

    /// The artifact now opens in another profile: a fresh view there, in the old one's place.
    async fn recreate(&mut self, old: ViewKey, artifact: ArtifactRef, profile: String) -> Option<ViewKey> {
        let placement = self.entries.get(&old).map_or(Placement::None, |e| e.placement.clone());
        let was_peek = self.peeked == Some(old);
        self.dispose(old, false).await;
        let key = self.create(artifact, profile).await?;
        if let Some(e) = self.entries.get_mut(&key) {
            e.placement = placement;
        }
        if was_peek {
            self.peeked = Some(key);
        }
        self.apply(key).await;
        Some(key)
    }

    /// Reloads a ready view behind itself, so it never blanks; anything else in place.
    async fn refresh(&mut self, key: ViewKey) {
        let Some(e) = self.entries.get(&key) else { return };
        if let Some(next) = e.next {
            self.dispose(next, false).await;
        }
        let Some(e) = self.entries.get(&key) else { return };
        if e.state != ViewState::Ready {
            self.load(key, true);
            return;
        }
        let (artifact, profile) = (e.artifact.clone(), e.profile.clone());
        let Some(next) = self.build(artifact, profile).await else { return };
        if let Some(n) = self.entries.get_mut(&next) {
            n.replaces = Some(key);
        }
        if let Some(e) = self.entries.get_mut(&key) {
            e.next = Some(next);
        }
        self.load(next, true);
    }

    /// The replacement finished loading: ready takes the old view's place, anything else is
    /// reported on the view the user sees.
    async fn settle(&mut self, next: ViewKey) {
        let Some(n) = self.entries.get(&next) else { return };
        let Some(old) = n.replaces else { return };
        if n.state == ViewState::Loading {
            return;
        }
        if n.state != ViewState::Ready {
            let (state, error) = (n.state, n.error.clone());
            self.dispose(next, false).await;
            self.set_state(old, state, error).await;
            return;
        }
        let placement = self.entries.get(&old).map_or(Placement::None, |e| e.placement.clone());
        if let Some(e) = self.entries.get_mut(&old) {
            e.next = None;
        }
        if let Some(n) = self.entries.get_mut(&next) {
            n.replaces = None;
            n.placement = placement;
            n.last_used = Instant::now();
            self.by_slug.insert(n.slug.clone(), next);
        }
        if self.peeked == Some(old) {
            self.peeked = Some(next);
        }
        self.apply(next).await;
        self.dispose(old, false).await;
    }

    async fn dispose(&mut self, key: ViewKey, announce: bool) {
        let Some(e) = self.entries.remove(&key) else { return };
        if let Some(next) = e.next {
            Box::pin(self.dispose(next, false)).await;
        }
        if let Some(old) = e.replaces
            && let Some(o) = self.entries.get_mut(&old)
        {
            o.next = None;
        }
        if self.by_slug.get(&e.slug) == Some(&key) {
            self.by_slug.remove(&e.slug);
        }
        if self.peeked == Some(key) {
            self.peeked = None;
        }
        self.surface.close(key).await;
        if announce {
            (self.emit)("artifacts:state", json!({ "slug": e.slug, "state": "idle" }));
        }
    }

    /// `keep` is the view the current call is about: never its own eviction.
    async fn trim(&mut self, keep: Option<ViewKey>) {
        let now = Instant::now();
        let items: Vec<PoolItem<ViewKey>> = self
            .by_slug
            .values()
            .filter_map(|key| self.entries.get(key).map(|e| (*key, e)))
            .map(|(key, e)| PoolItem {
                key,
                placed: !matches!(e.placement, Placement::None) || Some(key) == keep,
                idle: now.saturating_duration_since(e.last_used),
            })
            .collect();
        for key in pick_evictions(&items, POOL_CAP, IDLE) {
            self.dispose(key, true).await;
        }
    }

    // ---- placement ------------------------------------------------------------------

    async fn end_peek(&mut self, key: ViewKey) {
        if self.peeked == Some(key) {
            self.peeked = None;
        }
        let Some(e) = self.entries.get_mut(&key) else { return };
        let Placement::Peek { from, .. } = &mut e.placement else { return };
        e.placement = from.take().map_or(Placement::None, Placement::Tab);
        e.last_used = Instant::now();
        let still_due = e.still_due;
        self.apply(key).await;
        if still_due {
            self.schedule_still(key);
        }
    }

    async fn unplace(&mut self, key: ViewKey) {
        let Some(e) = self.entries.get_mut(&key) else { return };
        e.placement = Placement::None;
        e.last_used = Instant::now();
        let still_due = e.still_due;
        self.apply(key).await;
        if still_due {
            self.schedule_still(key);
        }
    }

    /// Bounds, visibility, corner radius, zoom and sound from the place and the state. A
    /// placed view shows only once ready (the dashboard paints the still until then) and
    /// keeps the place's size while it waits, so it appears laid out.
    async fn apply(&mut self, key: ViewKey) {
        let covered = self.covered;
        let on_screen = self.surface.window_on_screen();
        let Some(e) = self.entries.get_mut(&key) else { return };
        let (rect, wanted, radius, tab) = match &e.placement {
            Placement::None => (None, false, 0.0, false),
            Placement::Peek { rect, .. } => (Some(*rect), true, PEEK_RADIUS, false),
            Placement::Tab(t) => (Some(t.rect), t.visible, TAB_RADIUS, true),
        };
        let sized = rect.filter(|r| !r.is_empty());
        let show = wanted && sized.is_some() && e.state == ViewState::Ready && !covered;
        let target = match (show, sized) {
            (true, Some(rect)) => Shown::At(rect, radius),
            (_, Some(rect)) => Shown::Hidden((rect.width, rect.height)),
            (_, None) => Shown::Hidden(HIDDEN_SIZE),
        };
        let peek = matches!(e.placement, Placement::Peek { .. });
        let muted = !(show && tab && on_screen);
        let (shown_was, peek_was, muted_was) = (e.shown, e.peek, e.muted);
        e.shown = target;
        e.peek = peek;
        e.muted = Some(muted);
        if peek != peek_was {
            self.surface.set_peek(key, peek).await;
        }
        if target != shown_was {
            match target {
                Shown::At(rect, radius) => self.surface.show(key, rect, radius).await,
                Shown::Hidden(size) => self.surface.hide(key, size).await,
            }
        }
        if muted_was != Some(muted) {
            self.surface.set_muted(key, muted).await;
        }
        self.sync_throttle(key).await;
    }

    /// A page nobody sees is throttled once its still is taken; until then it has to keep
    /// painting.
    async fn sync_throttle(&mut self, key: ViewKey) {
        let Some(e) = self.entries.get_mut(&key) else { return };
        let throttle = !e.on_screen() && !e.capturing;
        if throttle != e.throttled {
            e.throttled = throttle;
            self.surface.set_throttled(key, throttle).await;
        }
    }

    // ---- loading and state ----------------------------------------------------------

    fn later(&self, delay: Duration, command: Command) {
        let tx = self.tx.clone();
        self.rt.spawn(async move {
            tokio::time::sleep(delay).await;
            if let Some(tx) = tx.upgrade() {
                let _ = tx.send(command).await;
            }
        });
    }

    /// Starts a load: the sign-in is checked first, then the viewer navigates.
    fn load(&mut self, key: ViewKey, recapture: bool) {
        let Some(e) = self.entries.get_mut(&key) else { return };
        e.seq += 1;
        e.capturing = true;
        e.recapture |= recapture;
        e.still_due = false;
        e.loaded_version = e.artifact.version.clone();
        let (seq, profile, surface, tx) = (e.seq, e.profile.clone(), self.surface.clone(), self.tx.clone());
        self.rt.spawn(async move {
            let signed_in = surface.signed_in(&profile).await;
            if let Some(tx) = tx.upgrade() {
                let _ = tx.send(Command::Checked { key, seq, signed_in }).await;
            }
        });
    }

    async fn checked(&mut self, key: ViewKey, seq: u64, signed_in: bool) {
        let Some(e) = self.entries.get(&key) else { return };
        if e.seq != seq {
            return;
        }
        if !signed_in {
            return self.set_state(key, ViewState::Signin, None).await;
        }
        let url = self.viewer.viewer_url(&e.slug);
        self.sync_throttle(key).await;
        self.set_state(key, ViewState::Loading, None).await;
        self.surface.navigate(key, &url).await;
        self.later(LOAD_TIMEOUT, Command::Timer { key, seq, timer: Timer::LoadTimeout });
    }

    async fn timer(&mut self, key: ViewKey, seq: u64, timer: Timer) {
        let Some(e) = self.entries.get(&key) else { return };
        if e.seq != seq {
            return;
        }
        match timer {
            Timer::LoadTimeout if e.state == ViewState::Loading => {
                // A subresource that never finishes holds back the load event: a page that
                // got as far as its DOM is shown anyway.
                if e.dom_seq == Some(seq) {
                    self.set_state(key, ViewState::Ready, None).await;
                } else {
                    self.set_state(key, ViewState::Error, Some("The artifact took too long to load".into())).await;
                }
            }
            Timer::Ready if e.state == ViewState::Loading => self.set_state(key, ViewState::Ready, None).await,
            Timer::StillSettle => self.take_still(key, seq),
            _ => {}
        }
    }

    async fn set_state(&mut self, key: ViewKey, state: ViewState, error: Option<String>) {
        let Some(e) = self.entries.get_mut(&key) else { return };
        let error = (state == ViewState::Error).then(|| error.unwrap_or_else(|| "The artifact didn't load".into()));
        if e.state == state && e.error == error {
            return;
        }
        e.state = state;
        e.error = error.clone();
        if state == ViewState::Ready {
            self.prepare_still(key);
        } else if state != ViewState::Loading {
            e.capturing = false;
        }
        let Some(e) = self.entries.get(&key) else { return };
        if e.replaces.is_some() {
            return Box::pin(self.settle(key)).await;
        }
        let slug = e.slug.clone();
        self.apply(key).await;
        let mut payload = json!({ "slug": slug, "state": state.name() });
        if let Some(error) = error {
            payload["error"] = Value::String(error);
        }
        (self.emit)("artifacts:state", payload);
    }

    async fn signed_out(&mut self, profile: &str) {
        let keys: Vec<ViewKey> = self.entries.iter().filter(|(_, e)| e.profile == profile).map(|(k, _)| *k).collect();
        for key in keys {
            let Some(e) = self.entries.get_mut(&key) else { continue };
            if e.replaces.is_some() {
                continue;
            }
            let next = e.next.take();
            e.seq += 1;
            if let Some(next) = next {
                self.dispose(next, false).await;
            }
            self.set_state(key, ViewState::Signin, None).await;
            self.surface.navigate(key, "about:blank").await;
        }
    }

    async fn surface_event(&mut self, key: ViewKey, event: SurfaceEvent) {
        let Some(e) = self.entries.get_mut(&key) else { return };
        let shown = e.on_screen();
        match event {
            SurfaceEvent::Navigated { url } => {
                if self.viewer.is_login(&url) {
                    self.set_state(key, ViewState::Signin, None).await;
                }
            }
            SurfaceEvent::Failed { description } => {
                let error = if description.is_empty() { None } else { Some(description) };
                self.set_state(key, ViewState::Error, error).await;
            }
            SurfaceEvent::InPage { url } => {
                // claude.ai routes in the page too, which no navigation announces.
                if self.viewer.is_login(&url) {
                    self.set_state(key, ViewState::Signin, None).await;
                } else if !self.viewer.is_viewer(&url) {
                    if shown && is_web(&url) {
                        self.surface.open_external(&url);
                    }
                    if !(shown && self.surface.go_back(key).await) {
                        self.set_state(key, ViewState::Error, Some("The artifact page moved away".into())).await;
                    }
                }
            }
            SurfaceEvent::DomReady => e.dom_seq = Some(e.seq),
            SurfaceEvent::Loaded => {
                if e.state == ViewState::Loading {
                    let seq = e.seq;
                    self.later(READY_DELAY, Command::Timer { key, seq, timer: Timer::Ready });
                }
            }
            SurfaceEvent::Refused { url } => {
                if self.viewer.is_login(&url) {
                    self.set_state(key, ViewState::Signin, None).await;
                } else if e.state == ViewState::Loading {
                    self.set_state(key, ViewState::Error, Some("claude.ai sent this artifact somewhere else".into()))
                        .await;
                } else if shown && is_web(&url) {
                    // A link the user followed: the system browser shows it.
                    self.surface.open_external(&url);
                }
            }
            SurfaceEvent::OpenRequested { url } => {
                if shown && is_web(&url) {
                    self.surface.open_external(&url);
                }
            }
            SurfaceEvent::Shield { external } => {
                if !matches!(e.placement, Placement::Peek { .. }) {
                    return;
                }
                if external {
                    self.surface.open_external(&self.viewer.viewer_url(&e.slug));
                } else {
                    (self.emit)("artifacts:action", json!({ "slug": e.slug, "action": "open" }));
                }
            }
            SurfaceEvent::Crashed { reason } => {
                self.set_state(key, ViewState::Error, Some(format!("The page stopped ({reason})"))).await;
            }
        }
    }

    // ---- stills -----------------------------------------------------------------------

    /// A versioned still never goes stale, so one already on disk is kept unless this load
    /// was a reload.
    fn prepare_still(&mut self, key: ViewKey) {
        let Some(e) = self.entries.get(&key) else { return };
        let keep = !e.recapture && e.artifact.version.as_deref().is_some_and(|v| self.stills.has(&e.slug, Some(v)));
        if keep {
            self.finish_still(key);
        } else {
            self.schedule_still(key);
        }
    }

    fn schedule_still(&self, key: ViewKey) {
        if let Some(e) = self.entries.get(&key) {
            self.later(STILL_SETTLE, Command::Timer { key, seq: e.seq, timer: Timer::StillSettle });
        }
    }

    fn take_still(&mut self, key: ViewKey, seq: u64) {
        let Some(e) = self.entries.get_mut(&key) else { return };
        if e.state != ViewState::Ready {
            return;
        }
        // The miniature is zoomed out: the still is taken once the peek ends.
        if matches!(e.placement, Placement::Peek { .. }) {
            e.still_due = true;
            return;
        }
        let (surface, tx) = (self.surface.clone(), self.tx.clone());
        self.rt.spawn(async move {
            let jpeg = surface.capture(key).await;
            if let Some(tx) = tx.upgrade() {
                let _ = tx.send(Command::StillTaken { key, seq, jpeg }).await;
            }
        });
    }

    async fn still_taken(&mut self, key: ViewKey, seq: u64, jpeg: Option<Vec<u8>>) {
        let Some(e) = self.entries.get(&key) else { return };
        if e.seq != seq {
            return;
        }
        if let Some(jpeg) = jpeg.filter(|j| !j.is_empty()) {
            let (stills, slug, version) = (self.stills.clone(), e.slug.clone(), e.artifact.version.clone());
            let written =
                tokio::task::spawn_blocking(move || stills.write(&slug, version.as_deref(), &jpeg)).await.ok();
            match written {
                Some(Ok(())) if e.state == ViewState::Ready => {
                    // Said again, so a dashboard that found no still on `ready` asks once more.
                    (self.emit)("artifacts:state", json!({ "slug": e.slug, "state": "ready" }));
                }
                Some(Err(err)) => tracing::warn!(target: "eos::artifacts", error = %err, "a still was not written"),
                _ => {}
            }
        }
        self.finish_still(key);
        self.sync_throttle(key).await;
    }

    fn finish_still(&mut self, key: ViewKey) {
        if let Some(e) = self.entries.get_mut(&key) {
            e.capturing = false;
            e.recapture = false;
            e.still_due = false;
        }
    }
}

#[cfg(test)]
mod tests;
