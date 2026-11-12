//! Controlling (`manager/peer/HostLink.ts`): one link per paired host, kept
//! alive in the background.
//!
//! Connecting races every route the host might be on and keeps the first one
//! that proves the pinned identity. Liveness is an HTTP/2 PING, which doubles
//! as the latency the dashboard shows. A host that refuses this computer
//! (revoked, remote access switched off) says so in its GOAWAY, and the link
//! stops retrying instead of looping as if the network were down.

mod dial;
mod request;
mod service;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use bytes::Bytes;
use eos_contracts::{HostInfo, KnownHost, LinkRoute, LinkState, LinkStatus, PEER_HUMAN_HEADER, peer_refusal};
use eos_core::Clock;
use eos_core::net::peer::PeerEvents;
use eos_core::net::relay::{Relay, RoomJoin};
use eos_domain::peer::{blocked_from_local_network, explain_dial_failures, link_error, parse_address};
use h2::client::SendRequest;
use h2::{Ping, PingPong};
use tokio::sync::{Notify, oneshot};
use tokio::task::AbortHandle;

use self::dial::{Attempt, Failed, Secured, Via, race};
pub(crate) use self::request::{Answer, LinkBody, collect, send};
pub(crate) use self::service::{HostLinkService, PairOffer};
use crate::channel::goaway::GoAwayTap;
use crate::channel::h2util::client_handshake;
use crate::channel::pipe::H2Pipe;
use crate::channel::{BoxIo, Channel};
use crate::host::PeerHost;
use crate::stores::KnownHosts;

const DIAL_TIMEOUT: Duration = Duration::from_secs(6);
/// Direct candidates start this far apart; the relay joins after them so a
/// reachable LAN address wins without waiting for the relay handshake.
const STAGGER: Duration = Duration::from_millis(150);
/// A tunnel from the host rides a link that is already up: tried before the relay.
const REVERSE_DELAY: Duration = Duration::from_millis(200);
const RELAY_DELAY: Duration = Duration::from_millis(400);
/// A tunnel this computer offered was used up or dropped: offer the next after this.
const REOFFER: Duration = Duration::from_secs(1);
pub(crate) const PING_INTERVAL: Duration = Duration::from_secs(10);
const PING_TIMEOUT: Duration = Duration::from_secs(6);
const BACKOFF_MS: [u64; 6] = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
/// Remote access switched off on the host: check back now and then, not in a loop.
const HOSTING_OFF_RETRY: Duration = Duration::from_secs(30);
/// Off a direct path, look for one this often (and on every network change).
const UPGRADE_INTERVAL: Duration = Duration::from_secs(30);
const FIRST_UPGRADE: Duration = Duration::from_secs(3);
/// A replaced session gets this long to finish the requests in flight.
const DRAIN: Duration = Duration::from_secs(5);
/// The largest event frame the notification watcher holds while it waits for
/// the frame's end.
const MAX_EVENT_FRAME_BYTES: usize = 1024 * 1024;
const HOST_INFO_PATH: &str = "/api/host";
const REVERSE_PATH: &str = "/peer/reverse";

/// Why there is no live link to send on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Unavailable {
    /// One of [`link_error`]'s codes.
    pub(crate) code: String,
    pub(crate) message: String,
}

impl Unavailable {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.to_owned(), message: message.into() }
    }
}

/// What every link of this computer shares.
pub(crate) struct LinkDeps {
    pub(crate) channel: Arc<Channel>,
    pub(crate) hosts: Arc<KnownHosts>,
    pub(crate) relay: Option<Arc<dyn Relay>>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) events: Arc<dyn PeerEvents>,
    /// This computer as a host: where a tunnel offered to a host lands.
    pub(crate) peer_host: Weak<PeerHost>,
    pub(crate) ping_interval: Duration,
    /// Whether this run may dial at all.
    pub(crate) network: bool,
}

/// Someone waiting for a live session to send on.
type Waiter = oneshot::Sender<Result<SendRequest<Bytes>, Unavailable>>;

struct Session {
    id: u64,
    sender: SendRequest<Bytes>,
    /// Stops the task that drives the connection: the socket closes at once.
    driver: AbortHandle,
    ping_now: Arc<Notify>,
}

struct State {
    status: LinkStatus,
    info: Option<HostInfo>,
    session: Option<Session>,
    dialing: bool,
    stopped: bool,
    retry: Option<AbortHandle>,
    /// The ping and upgrade loops of the live session.
    session_tasks: Vec<AbortHandle>,
    upgrading: bool,
    waiters: Vec<(u64, Waiter)>,
    last_failure: Option<String>,
    /// The route the last live session ran on.
    last_route: Option<LinkRoute>,
    /// A tunnel the host opened back to this computer, kept ready as a way in.
    reverse: Option<BoxIo>,
    /// The tunnel this computer offered the host through the live session.
    offered: Option<u64>,
}

pub(crate) struct HostLink {
    host_id: String,
    deps: Arc<LinkDeps>,
    state: Mutex<State>,
    counter: AtomicU64,
    me: Weak<HostLink>,
}

impl std::fmt::Debug for HostLink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostLink").field("host", &&self.host_id[..16.min(self.host_id.len())]).finish_non_exhaustive()
    }
}

/// What a status change sets; `None` leaves the field.
#[derive(Default)]
struct Patch {
    state: Option<LinkState>,
    route: Option<Option<LinkRoute>>,
    rtt_ms: Option<Option<f64>>,
    error: Option<Option<String>>,
    attempt: Option<i64>,
}

/// A fraction in `0.8..1.2`, so retries of many links do not line up.
fn jitter() -> f64 {
    let mut byte = [0u8; 1];
    let _ = getrandom::fill(&mut byte);
    0.8 + f64::from(byte[0]) / 255.0 * 0.4
}

impl HostLink {
    pub(crate) fn new(host_id: &str, deps: Arc<LinkDeps>) -> Arc<Self> {
        let status = LinkStatus {
            state: LinkState::Offline,
            route: None,
            rtt_ms: None,
            since: deps.clock.now_ms().into(),
            attempt: 0,
            error: None,
        };
        Arc::new_cyclic(|me| Self {
            host_id: host_id.to_owned(),
            deps,
            state: Mutex::new(State {
                status,
                info: None,
                session: None,
                dialing: false,
                stopped: true,
                retry: None,
                session_tasks: Vec::new(),
                upgrading: false,
                waiters: Vec::new(),
                last_failure: None,
                last_route: None,
                reverse: None,
                offered: None,
            }),
            counter: AtomicU64::new(1),
            me: me.clone(),
        })
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn next_id(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::Relaxed)
    }

    fn host(&self) -> Option<KnownHost> {
        self.deps.hosts.get(&self.host_id)
    }

    /// Runs `work` on its own task for as long as this link exists.
    fn spawn<F, Fut>(&self, work: F) -> AbortHandle
    where
        F: FnOnce(Arc<HostLink>) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let me = self.me.clone();
        tokio::spawn(async move {
            if let Some(link) = me.upgrade() {
                work(link).await;
            }
        })
        .abort_handle()
    }

    pub(crate) fn status(&self) -> LinkStatus {
        self.state().status.clone()
    }

    pub(crate) fn info(&self) -> Option<HostInfo> {
        self.state().info.clone()
    }

    pub(crate) fn start(&self) {
        {
            let mut state = self.state();
            if !state.stopped {
                return;
            }
            state.stopped = false;
        }
        self.spawn(|link| async move { link.connect().await });
    }

    pub(crate) fn stop(&self) {
        let mut state = self.state();
        state.stopped = true;
        Self::clear_timers(&mut state);
        if let Some(session) = state.session.take() {
            session.driver.abort();
        }
        state.reverse = None;
        state.offered = None;
        Self::reject_waiters(&mut state, &Unavailable::new(link_error::UNREACHABLE, "link stopped"));
        let patch = Patch {
            state: Some(LinkState::Offline),
            route: Some(None),
            rtt_ms: Some(None),
            error: Some(None),
            attempt: Some(0),
        };
        self.set_status(state, patch);
    }

    /// Something changed that may have broken or healed the path (a network
    /// switch, a wake from sleep, the user pressing Reconnect): probe now
    /// instead of waiting.
    pub(crate) fn kick(&self) {
        let mut state = self.state();
        if state.stopped {
            return;
        }
        if let Some(session) = &state.session {
            session.ping_now.notify_one();
            if state.status.route != Some(LinkRoute::Direct) {
                drop(state);
                self.spawn(|link| async move { link.try_upgrade().await });
            }
            return;
        }
        if let Some(retry) = state.retry.take() {
            retry.abort();
        }
        state.status.attempt = 0;
        drop(state);
        self.spawn(|link| async move { link.connect().await });
    }

    /// A live session to send on, waiting up to `timeout` for one. Fails at
    /// once when the host has refused this computer: a request would never
    /// succeed.
    pub(crate) async fn ready(&self, timeout: Duration) -> Result<SendRequest<Bytes>, Unavailable> {
        let (id, waiting) = {
            let mut state = self.state();
            if let Some(session) = &state.session {
                return Ok(session.sender.clone());
            }
            if state.status.state == LinkState::Unauthorized || state.stopped {
                let code = state.status.error.clone().unwrap_or_else(|| link_error::UNREACHABLE.to_owned());
                return Err(Unavailable { code, message: "host refused this device".into() });
            }
            let (tx, rx) = oneshot::channel();
            let id = self.next_id();
            state.waiters.push((id, tx));
            if !state.dialing && state.retry.is_none() {
                self.spawn(|link| async move { link.connect().await });
            }
            (id, rx)
        };
        match tokio::time::timeout(timeout, waiting).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) | Err(_) => {
                let mut state = self.state();
                state.waiters.retain(|(waiter, _)| *waiter != id);
                let code = state.status.error.clone().unwrap_or_else(|| link_error::UNREACHABLE.to_owned());
                Err(Unavailable { code, message: "host is not reachable right now".into() })
            }
        }
    }

    /// The host opened a tunnel back to this computer inside its own link
    /// here: the way in when this computer has no path of its own (no route
    /// into the host's network, Local Network privacy, the relay out of reach).
    pub(crate) fn add_reverse(&self, pipe: BoxIo) {
        let mut state = self.state();
        if state.stopped {
            return;
        }
        state.reverse = Some(pipe);
        let idle = state.session.is_none() && !state.dialing;
        drop(state);
        if idle {
            self.kick();
        }
    }

    /// The host may also control this computer: hand it a tunnel back through
    /// this session, so it reaches this computer even when it has no path of
    /// its own. Never through a session that itself rides such a tunnel.
    pub(crate) fn offer_reverse(&self) {
        let Some(host) = self.deps.peer_host.upgrade() else { return };
        if !host.allows_control_from(&self.host_id) {
            return;
        }
        let (sender, session, offer) = {
            let mut state = self.state();
            let Some(live) = &state.session else { return };
            if state.offered.is_some() || state.status.route == Some(LinkRoute::Reverse) {
                return;
            }
            let (sender, session) = (live.sender.clone(), live.id);
            let offer = self.next_id();
            state.offered = Some(offer);
            (sender, session, offer)
        };
        self.spawn(move |link| async move {
            let taken = link.offer(sender, &host).await;
            let still_live = {
                let mut state = link.state();
                if state.offered == Some(offer) {
                    state.offered = None;
                }
                state.session.as_ref().is_some_and(|s| s.id == session)
            };
            // Used or dropped: offer the next while this session lives. A host
            // that declined is asked again only when trust changes.
            if taken && still_live {
                tokio::time::sleep(REOFFER).await;
                link.offer_reverse();
            }
        });
    }

    /// Offers one tunnel and resolves when it is over; `true` when the host took it.
    async fn offer(&self, sender: SendRequest<Bytes>, host: &Arc<PeerHost>) -> bool {
        let Ok(mut sender) = sender.ready().await else { return false };
        let Ok(request) =
            http::Request::builder().method("POST").uri(format!("https://eos-peer{REVERSE_PATH}")).body(())
        else {
            return false;
        };
        let Ok((response, send)) = sender.send_request(request, false) else { return false };
        let Ok(response) = response.await else { return false };
        if response.status().as_u16() != 200 {
            return false;
        }
        let (closed_tx, closed_rx) = oneshot::channel::<()>();
        host.accept_pipe(Box::new(Watched { io: H2Pipe::new(send, response.into_body()), _closed: closed_tx }));
        let _ = closed_rx.await;
        true
    }

    async fn connect(&self) {
        let host = {
            let mut state = self.state();
            if state.stopped || state.dialing || state.session.is_some() {
                return;
            }
            let Some(host) = self.host() else {
                drop(state);
                self.stop();
                return;
            };
            state.dialing = true;
            let attempt = state.status.attempt + 1;
            let next = if state.status.state == LinkState::Live || attempt > 1 {
                LinkState::Reconnecting
            } else {
                LinkState::Connecting
            };
            self.set_status(state, Patch { state: Some(next), attempt: Some(attempt), ..Patch::default() });
            host
        };
        let dialed = self.dial(&host).await;
        let adopted = match dialed {
            Ok((tls, route)) => self
                .adopt(tls, route, None)
                .await
                .map_err(|e| DialError::Unavailable(Unavailable::new(link_error::UNREACHABLE, e))),
            Err(e) => Err(e),
        };
        let mut state = self.state();
        state.dialing = false;
        match adopted {
            Ok(_) => {}
            Err(DialError::IdentityChanged) => self.refuse(state, link_error::IDENTITY_CHANGED),
            Err(DialError::Unavailable(e)) if e.code == link_error::NOT_PAIRED => {
                self.refuse(state, link_error::NOT_PAIRED)
            }
            Err(DialError::Unavailable(e)) => {
                // Retries repeat the same failure; say why once, and again when it changes.
                if state.last_failure.as_deref() != Some(e.message.as_str()) {
                    state.last_failure = Some(e.message.clone());
                    tracing::warn!(host = %host.name, why = %e.message, "no route to host");
                }
                // A tunnel from the host arrived while this dial ran: use it now.
                let delay = state.reverse.is_some().then_some(Duration::ZERO);
                let state = self.set_status_keep(
                    state,
                    Patch {
                        state: Some(LinkState::Reconnecting),
                        route: Some(None),
                        rtt_ms: Some(None),
                        error: Some(Some(e.code)),
                        ..Patch::default()
                    },
                );
                self.schedule_retry(state, delay);
            }
        }
    }

    async fn dial(&self, host: &KnownHost) -> Result<(Secured, LinkRoute), DialError> {
        let mut attempts: Vec<Attempt> = Vec::new();
        for (i, addr) in host.addrs.iter().enumerate() {
            if let Some(target) = parse_address(addr) {
                attempts.push(Attempt {
                    delay: STAGGER * u32::try_from(i).unwrap_or(u32::MAX),
                    route: LinkRoute::Direct,
                    via: Via::Direct(target),
                });
            }
        }
        let (has_reverse, last_route) = {
            let state = self.state();
            (state.reverse.is_some(), state.last_route)
        };
        if has_reverse {
            let me = self.me.clone();
            attempts.push(Attempt {
                delay: if attempts.is_empty() { Duration::ZERO } else { REVERSE_DELAY },
                route: LinkRoute::Reverse,
                via: Via::Reverse(Box::new(move || me.upgrade().and_then(|link| link.state().reverse.take()))),
            });
        }
        if let (Some(_), Some(grant)) = (&self.deps.relay, &host.relay) {
            attempts.push(Attempt {
                // The relay is where the last link lived (the direct addresses
                // did not answer then): dial it at once instead of after the
                // direct head start.
                delay: if attempts.is_empty() || last_route == Some(LinkRoute::Relay) {
                    Duration::ZERO
                } else {
                    RELAY_DELAY
                },
                route: LinkRoute::Relay,
                via: Via::Relay(RoomJoin {
                    url: grant.url.clone(),
                    room: grant.room.clone(),
                    bearer: grant.bearer.clone(),
                }),
            });
        }
        if attempts.is_empty() {
            return Err(DialError::Unavailable(Unavailable::new(
                link_error::NO_ROUTE,
                "no address or relay for this host",
            )));
        }
        race(&self.deps.channel, self.deps.relay.as_ref(), &host.id.0, attempts, DIAL_TIMEOUT)
            .await
            .map_err(|failures| DialError::from_failures(&failures))
    }

    /// Makes the secured stream the link's live session. With `replacing`,
    /// only in place of that session (a move to a direct path), which is then
    /// left to drain.
    async fn adopt(&self, tls: Secured, route: LinkRoute, replacing: Option<u64>) -> Result<bool, String> {
        let (tap, goaway) = GoAwayTap::new(tls);
        let (sender, mut connection) = client_handshake(tap).await.map_err(|e| e.to_string())?;
        let ping_pong = connection.ping_pong();
        let id = self.next_id();
        let driver = self.spawn(move |link| async move {
            let _ = connection.await;
            let reason = goaway.get().and_then(|frame| frame.reason().map(str::to_owned));
            link.session_closed(id, reason.as_deref());
        });
        let ping_now = Arc::new(Notify::new());
        let waiters = {
            let mut state = self.state();
            let current = state.session.as_ref().map(|s| s.id);
            if state.stopped || current != replacing {
                driver.abort();
                return Ok(false);
            }
            Self::clear_timers(&mut state);
            let fresh = Session { id, sender: sender.clone(), driver, ping_now: ping_now.clone() };
            if let Some(Session { sender: old, driver: old_driver, .. }) = state.session.replace(fresh) {
                // Our handle on the old session goes now; its connection ends
                // once the requests in flight have, or after the drain.
                drop(old);
                tokio::spawn(async move {
                    tokio::time::sleep(DRAIN).await;
                    old_driver.abort();
                });
            }
            state.last_route = Some(route);
            state.last_failure = None;
            // An offer made through the previous session dies with it.
            state.offered = None;
            let waiters = std::mem::take(&mut state.waiters);
            let mut state = self.set_status_keep(
                state,
                Patch {
                    state: Some(LinkState::Live),
                    route: Some(Some(route)),
                    error: Some(None),
                    attempt: Some(0),
                    ..Patch::default()
                },
            );
            if let Some(ping_pong) = ping_pong {
                let interval = self.deps.ping_interval;
                state.session_tasks.push(self.spawn(move |link| link.ping_loop(id, ping_pong, ping_now, interval)));
            }
            if route != LinkRoute::Direct && self.host().is_some_and(|h| !h.addrs.is_empty()) {
                state.session_tasks.push(self.spawn(|link| async move {
                    tokio::time::sleep(FIRST_UPGRADE).await;
                    loop {
                        // On its own task: an upgrade ends this loop.
                        link.spawn(|link| async move { link.try_upgrade().await });
                        tokio::time::sleep(UPGRADE_INTERVAL).await;
                    }
                }));
            }
            waiters
        };
        for (_, waiter) in waiters {
            let _ = waiter.send(Ok(sender.clone()));
        }
        let info_sender = sender.clone();
        self.spawn(move |link| async move { link.refresh_info(id, info_sender).await });
        self.spawn(move |link| async move { link.watch_notifications(sender).await });
        self.offer_reverse();
        Ok(true)
    }

    /// The session's connection ended; `refusal` is what the host said in its GOAWAY.
    fn session_closed(&self, id: u64, refusal: Option<&str>) {
        let mut state = self.state();
        if state.session.as_ref().is_none_or(|s| s.id != id) {
            return;
        }
        state.session = None;
        Self::clear_timers(&mut state);
        if state.stopped {
            return;
        }
        let refusal = refusal.filter(|r| [peer_refusal::NOT_PAIRED, peer_refusal::HOSTING_OFF].contains(r));
        if refusal == Some(peer_refusal::NOT_PAIRED) {
            self.refuse(state, link_error::NOT_PAIRED);
            return;
        }
        let state = self.set_status_keep(
            state,
            Patch {
                state: Some(LinkState::Reconnecting),
                route: Some(None),
                rtt_ms: Some(None),
                error: Some(refusal.map(str::to_owned)),
                ..Patch::default()
            },
        );
        let delay = if refusal == Some(peer_refusal::HOSTING_OFF) { HOSTING_OFF_RETRY } else { Duration::ZERO };
        self.schedule_retry(state, Some(delay));
    }

    /// Closes a session at once (its socket with it) and reconnects.
    fn destroy(&self, id: u64) {
        let driver = self.state().session.as_ref().filter(|s| s.id == id).map(|s| s.driver.clone());
        if let Some(driver) = driver {
            driver.abort();
            self.session_closed(id, None);
        }
    }

    async fn ping_loop(self: Arc<Self>, id: u64, mut ping_pong: PingPong, ping_now: Arc<Notify>, interval: Duration) {
        loop {
            let sent = tokio::time::Instant::now();
            match tokio::time::timeout(PING_TIMEOUT, ping_pong.ping(Ping::opaque())).await {
                Ok(Ok(_)) => {
                    let took = sent.elapsed().as_secs_f64() * 1000.0;
                    let state = self.state();
                    if state.session.as_ref().is_some_and(|s| s.id == id) {
                        let smoothed = state.status.rtt_ms.map_or(took, |prev| prev.0 * 0.7 + took * 0.3);
                        let rounded = (smoothed * 10.0).round() / 10.0;
                        self.set_status(state, Patch { rtt_ms: Some(Some(rounded)), ..Patch::default() });
                    }
                }
                // The connection failed: its own task reports that.
                Ok(Err(_)) => return,
                Err(_) => {
                    tracing::info!(host = ?self.host().map(|h| h.name), "ping unanswered — reconnecting");
                    self.destroy(id);
                    return;
                }
            }
            tokio::select! {
                () = tokio::time::sleep(interval) => {}
                () = ping_now.notified() => {}
            }
        }
    }

    /// On the relay or a tunnel while the host also has direct addresses (the
    /// same LAN, a tailnet): once one answers, the link moves there. New
    /// requests take the new session at once; the old one drains, then its
    /// event streams break and the dashboard resumes them from their last
    /// event id.
    fn try_upgrade(self: Arc<Self>) -> eos_core::BoxFuture<'static, ()> {
        // Boxed: a session's upgrade loop runs this, and this adopts a session.
        Box::pin(async move { self.upgrade().await })
    }

    async fn upgrade(&self) {
        let Some(host) = self.host() else { return };
        let old = {
            let mut state = self.state();
            let Some(session) = &state.session else { return };
            if state.upgrading || state.status.route == Some(LinkRoute::Direct) {
                return;
            }
            let old = session.id;
            state.upgrading = true;
            old
        };
        let attempts: Vec<Attempt> = host
            .addrs
            .iter()
            .filter_map(|addr| parse_address(addr))
            .map(|target| Attempt { delay: Duration::ZERO, route: LinkRoute::Direct, via: Via::Direct(target) })
            .collect();
        if !attempts.is_empty()
            && let Ok((tls, _)) = race(&self.deps.channel, None, &host.id.0, attempts, DIAL_TIMEOUT).await
            && self.adopt(tls, LinkRoute::Direct, Some(old)).await == Ok(true)
        {
            tracing::info!(host = %host.name, "link moved to a direct path");
        }
        self.state().upgrading = false;
    }

    async fn refresh_info(&self, session: u64, sender: SendRequest<Bytes>) {
        let Ok(answer) = request::send(sender, "GET", HOST_INFO_PATH, &[], Bytes::new()).await else { return };
        let Ok(body) = request::collect(answer.body, 64 * 1024).await else { return };
        let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body) else { return };
        let Ok(info) = eos_contracts::parse::<HostInfo>(&json) else { return };
        {
            let mut state = self.state();
            if state.session.as_ref().is_none_or(|s| s.id != session) {
                return;
            }
            state.info = Some(info.clone());
        }
        if let Some(host) = self.host() {
            let now = Some(self.deps.clock.now_ms().into());
            self.deps.hosts.upsert(KnownHost {
                name: info.name,
                platform: info.platform,
                last_connected_at: now,
                ..host
            });
        }
        self.deps.events.host_changed(&self.host_id);
    }

    /// A filtered event stream (only `notification:fire`) for as long as this
    /// session lives; the next session opens its own. This is the app's own
    /// call, not some page's, so it vouches for itself.
    async fn watch_notifications(&self, sender: SendRequest<Bytes>) {
        let headers =
            [("accept".to_owned(), "text/event-stream".to_owned()), (PEER_HUMAN_HEADER.to_owned(), "1".to_owned())];
        let Ok(Answer { mut body, .. }) =
            request::send(sender, "GET", "/stream?topics=notification:fire", &headers, Bytes::new()).await
        else {
            return;
        };
        let mut buffer: Vec<u8> = Vec::new();
        while let Some(Ok(chunk)) = crate::channel::h2util::next_chunk(&mut body).await {
            buffer.extend_from_slice(&chunk);
            while let Some(end) = buffer.windows(2).position(|pair| pair == b"\n\n") {
                let frame: Vec<u8> = buffer.drain(..end + 2).collect();
                if let Some(payload) = notification_in(&frame) {
                    self.raise(payload);
                }
            }
            if buffer.len() > MAX_EVENT_FRAME_BYTES {
                buffer.clear();
            }
        }
    }

    /// Raises the host's notification here, so it reaches the person even when
    /// that host's window is closed.
    fn raise(&self, payload: serde_json::Value) {
        let (Some(host), serde_json::Value::Object(mut payload)) = (self.host(), payload) else { return };
        let Some(title) = payload.get("title").and_then(|t| t.as_str()).map(str::to_owned) else { return };
        // Only the host's own: one it relayed from another computer (`host`
        // set) would bounce between mutually paired computers without end.
        if payload.get("host").is_some_and(truthy) {
            return;
        }
        let shown = host.alias.filter(|a| !a.is_empty()).unwrap_or(host.name);
        payload.insert("title".into(), format!("{shown} · {title}").into());
        // `host` tells the window which computer to switch to on a click.
        payload.insert("host".into(), serde_json::json!({ "id": host.id.0, "name": shown }));
        self.deps.events.notification(payload.into());
    }

    fn refuse(&self, mut state: MutexGuard<'_, State>, code: &str) {
        Self::clear_timers(&mut state);
        Self::reject_waiters(&mut state, &Unavailable::new(code, "host refused this device"));
        self.set_status(
            state,
            Patch {
                state: Some(LinkState::Unauthorized),
                route: Some(None),
                rtt_ms: Some(None),
                error: Some(Some(code.to_owned())),
                ..Patch::default()
            },
        );
    }

    fn schedule_retry(&self, mut state: MutexGuard<'_, State>, delay: Option<Duration>) {
        if state.stopped || state.retry.is_some() {
            return;
        }
        let step = usize::try_from(state.status.attempt).unwrap_or(0).min(BACKOFF_MS.len() - 1);
        let base = delay.unwrap_or(Duration::from_millis(BACKOFF_MS[step]));
        let wait = base.mul_f64(jitter());
        state.retry = Some(self.spawn(move |link| async move {
            tokio::time::sleep(wait).await;
            link.state().retry = None;
            link.connect().await;
        }));
    }

    fn reject_waiters(state: &mut State, why: &Unavailable) {
        for (_, waiter) in state.waiters.drain(..) {
            let _ = waiter.send(Err(why.clone()));
        }
    }

    fn clear_timers(state: &mut State) {
        if let Some(retry) = state.retry.take() {
            retry.abort();
        }
        for task in state.session_tasks.drain(..) {
            task.abort();
        }
    }

    /// Applies a status change and announces it when something changed.
    fn set_status(&self, state: MutexGuard<'_, State>, patch: Patch) {
        drop(self.set_status_keep(state, patch));
    }

    fn set_status_keep<'a>(&'a self, mut state: MutexGuard<'a, State>, patch: Patch) -> MutexGuard<'a, State> {
        let before = state.status.clone();
        let mut next = before.clone();
        if let Some(v) = patch.state {
            next.state = v;
        }
        if let Some(v) = patch.route {
            next.route = v;
        }
        if let Some(v) = patch.rtt_ms {
            next.rtt_ms = v.map(Into::into);
        }
        if let Some(v) = patch.error {
            next.error = v;
        }
        if let Some(v) = patch.attempt {
            next.attempt = v;
        }
        if next.state != before.state || next.route != before.route {
            next.since = self.deps.clock.now_ms().into();
        }
        let changed = next != before;
        state.status = next;
        if changed {
            // Announced without the lock: a listener may read this link's status.
            drop(state);
            self.deps.events.host_changed(&self.host_id);
            return self.state();
        }
        state
    }
}

fn truthy(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        serde_json::Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The payload of a `notification:fire` event in one frame of the stream.
fn notification_in(frame: &[u8]) -> Option<serde_json::Value> {
    let text = std::str::from_utf8(frame).ok()?;
    if !text.contains("event: change") {
        return None;
    }
    let data = text.lines().find_map(|line| line.strip_prefix("data: "))?;
    let mut message: serde_json::Map<String, serde_json::Value> = serde_json::from_str(data).ok()?;
    (message.get("reason")?.as_str()? == "notification:fire").then(|| message.remove("payload").unwrap_or_default())
}

enum DialError {
    /// The host's own relay room answered with another identity.
    IdentityChanged,
    Unavailable(Unavailable),
}

impl DialError {
    fn from_failures(failures: &[Failed]) -> Self {
        // A different key at a LAN address is most likely another machine that
        // inherited the address; only the relay room — which is this host's
        // alone — proves the host itself changed identity.
        if failures.iter().any(|f| f.identity && f.failure.route == LinkRoute::Relay) {
            return Self::IdentityChanged;
        }
        // The relay only turns away a bearer the host withdrew: revoked.
        if failures.iter().any(Failed::relay_denied) {
            return Self::Unavailable(Unavailable::new(
                link_error::NOT_PAIRED,
                "the host's relay no longer admits this device",
            ));
        }
        let reasons: Vec<_> = failures.iter().map(|f| f.failure.clone()).collect();
        let last = failures.last();
        let code = if blocked_from_local_network(&reasons) {
            link_error::LOCAL_NETWORK
        } else {
            last.and_then(|f| f.link_code).unwrap_or(link_error::UNREACHABLE)
        };
        let explained = explain_dial_failures(&reasons);
        let message =
            if explained.is_empty() { last.map(|f| f.message.clone()).unwrap_or_default() } else { explained };
        Self::Unavailable(Unavailable::new(code, message))
    }
}

/// A byte stream that says when it is dropped.
struct Watched<IO> {
    io: IO,
    _closed: oneshot::Sender<()>,
}

impl<IO: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for Watched<IO> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl<IO: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for Watched<IO> {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_notification_frame_yields_a_payload() {
        let frame =
            b"id: e1-7\nevent: change\ndata: {\"reason\":\"notification:fire\",\"payload\":{\"title\":\"Done\"}}\n\n";
        assert_eq!(notification_in(frame), Some(serde_json::json!({ "title": "Done" })));
        assert_eq!(notification_in(b"event: change\ndata: {\"reason\":\"worker:change\",\"payload\":{}}\n\n"), None);
        assert_eq!(notification_in(b": ping\n\n"), None);
        assert_eq!(notification_in(b"event: change\ndata: {\"reason\"\n\n"), None);
    }

    #[test]
    fn the_failures_of_a_dial_decide_the_links_error() {
        let failed = |route, code: &str| Failed {
            failure: eos_domain::peer::DialFailure::new(route, code),
            identity: false,
            link_code: None,
            message: "raw".into(),
        };
        let code = |failures: &[Failed]| match DialError::from_failures(failures) {
            DialError::IdentityChanged => "identity-changed".to_owned(),
            DialError::Unavailable(e) => e.code,
        };
        assert_eq!(code(&[failed(LinkRoute::Direct, "ECONNREFUSED")]), "unreachable");
        assert_eq!(
            code(&[failed(LinkRoute::Direct, "EHOSTUNREACH"), failed(LinkRoute::Relay, "TIMEOUT")]),
            "local-network"
        );
        assert_eq!(
            code(&[failed(LinkRoute::Direct, "ECONNREFUSED"), failed(LinkRoute::Relay, "BEARER_DENIED")]),
            "not-paired"
        );
        // Another key at a direct address is another machine; on the relay it is the host itself.
        let wrong_key = |route| Failed { identity: true, ..failed(route, "UNKNOWN") };
        assert_eq!(code(&[wrong_key(LinkRoute::Direct)]), "unreachable");
        assert_eq!(code(&[wrong_key(LinkRoute::Direct), wrong_key(LinkRoute::Relay)]), "identity-changed");
    }
}
