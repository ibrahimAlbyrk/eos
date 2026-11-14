//! The link between two computers running Eos (`manager/peer`, `infra/src/peer`).
//!
//! Every app has one identity — a self-signed certificate under
//! `<home>/peer/`, whose fingerprint is its id — and plays both roles: it
//! hosts (paired computers control it) and it controls (it drives the
//! computers it paired with). Both run only while the app is open.
//!
//! ```text
//! controlling                                   hosting
//! facade route ─ HostLinks::forward ─▶ HostLink ══ TLS 1.3 + HTTP/2 ══▶ PeerHost ─ gateway ─▶ LocalApi (the app's routes)
//!                                      direct · relay · reverse tunnel
//! ```
//!
//! [`Peering`] is both halves over one identity. The app hands it its routes
//! ([`Peering::serve`]) and reads it through the ports of `eos_core::net`.

mod channel;
mod error;
mod host;
mod identity;
mod link;
mod machine;
mod relay_io;
pub mod stores;
mod x509;

use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use eos_contracts::{
    HostInfo, HostView, InviteResponse, OFF_NETWORK, PEER_HUMAN_HEADER, PeerStatus, PeerStatusRelay, UpdateHostRequest,
};
use eos_core::net::machines::{Machines, PeerCallError, PeerRequest, PeerResponse};
use eos_core::net::peer::{
    HostLinks, HostingOff, LinkError, LinkRequest, LocalApi, PairingError, PeerAnswer, PeerEvents, PeerHosting,
    PeerLifecycle,
};
use eos_core::net::relay::Relay;
use eos_core::{BoxFuture, Clock};

pub use channel::{BoxIo, Io};
pub use error::Error;
pub use host::{KeepAwake, PeerConfigSource};
pub use identity::{Identity, fingerprint};

use crate::channel::Channel;
use crate::host::{HostDeps, PeerHost};
use crate::link::{HostLinkService, LinkBody, LinkDeps, PairOffer};

/// How long a request waits for a (re)connecting link before it fails: long
/// enough to ride out a network switch, short enough that the dashboard can
/// say so.
const READY_TIMEOUT: Duration = Duration::from_secs(12);
/// The largest answer a buffered call to another computer keeps (a transfer
/// chunk, with room to spare).
const MAX_CALL_ANSWER_BYTES: usize = 64 * 1024 * 1024;

const DROP_RESPONSE: &[&str] = &["connection", "keep-alive", "transfer-encoding", "upgrade", "trailer"];

/// What peering is built from.
pub struct PeeringOptions {
    /// `<home>/peer`: the identity and the lists.
    pub peer_dir: PathBuf,
    pub clock: Arc<dyn Clock>,
    /// `config.peer` as it is now.
    pub config: PeerConfigSource,
    pub events: Arc<dyn PeerEvents>,
    /// The user's home folder, shown to controlling computers so they shorten paths correctly.
    pub home: String,
    /// The stamp of this build's route surface.
    pub api_stamp: String,
    /// Whether this app can serve its own dashboard bundle (`GET /ui/*`).
    pub serves_ui: Arc<dyn Fn() -> bool + Send + Sync>,
    /// The relay connection, when the build has one.
    pub relay: Option<Arc<dyn Relay>>,
    /// The relay other computers reach this one through when no direct path works.
    pub relay_url: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// The interface the direct listener binds; `None` is every interface.
    pub bind: Option<IpAddr>,
    /// Where devices reach the bound port; `None` reads this computer's interfaces.
    pub addresses: Option<Arc<dyn Fn(u16) -> Vec<String> + Send + Sync>>,
    pub keep_awake: KeepAwake,
    /// How often a live link is pinged.
    pub ping_interval: Duration,
    /// Whether this run may listen and dial at all. Without it the identity
    /// and the lists are read and shown, and nothing touches the network: a
    /// run on a copy of someone's data must never answer as that computer.
    pub network: bool,
}

impl std::fmt::Debug for PeeringOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeeringOptions").field("peer_dir", &self.peer_dir).finish_non_exhaustive()
    }
}

impl PeeringOptions {
    /// No relay, every interface, the system's keep-awake.
    pub fn new(
        peer_dir: impl Into<PathBuf>,
        clock: Arc<dyn Clock>,
        config: PeerConfigSource,
        events: Arc<dyn PeerEvents>,
    ) -> Self {
        Self {
            peer_dir: peer_dir.into(),
            clock,
            config,
            events,
            home: eos_platform::home_dir().map(|h| h.to_string_lossy().into_owned()).unwrap_or_default(),
            api_stamp: String::new(),
            serves_ui: Arc::new(|| false),
            relay: None,
            relay_url: Arc::new(|| None),
            bind: None,
            addresses: None,
            keep_awake: Arc::new(|| {
                let held = eos_platform::host().keep_awake(std::process::id()).ok()?;
                Some(Box::new(held) as Box<dyn Send + Sync>)
            }),
            ping_interval: link::PING_INTERVAL,
            network: true,
        }
    }
}

/// Hosting and controlling over this computer's one identity.
pub struct Peering {
    channel: Arc<Channel>,
    host: Arc<PeerHost>,
    links: Arc<HostLinkService>,
    network: bool,
}

impl std::fmt::Debug for Peering {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Peering").field("id", &self.channel.fingerprint()).finish_non_exhaustive()
    }
}

impl Peering {
    /// Reads the identity and the lists under `peer_dir` (minting the
    /// identity in a folder that has none). Nothing listens or dials yet.
    pub fn open(options: PeeringOptions) -> Result<Arc<Self>, Error> {
        let identity = Arc::new(Identity::load_or_create(&options.peer_dir, options.clock.now_ms())?);
        let channel = Arc::new(Channel::new(identity)?);
        let host = PeerHost::new(HostDeps {
            peer_dir: options.peer_dir.clone(),
            channel: channel.clone(),
            config: options.config,
            clock: options.clock.clone(),
            events: options.events.clone(),
            home: options.home,
            api_stamp: options.api_stamp,
            serves_ui: options.serves_ui,
            relay: options.relay.clone(),
            relay_url: options.relay_url,
            bind: options.bind,
            addresses: options.addresses,
            keep_awake: options.keep_awake,
        });
        let name_of = Arc::downgrade(&host);
        let links = HostLinkService::new(
            Arc::new(LinkDeps {
                channel: channel.clone(),
                hosts: Arc::new(stores::known_hosts(&options.peer_dir)),
                relay: options.relay,
                clock: options.clock,
                events: options.events,
                peer_host: Arc::downgrade(&host),
                ping_interval: options.ping_interval,
                network: options.network,
            }),
            Arc::new(move || name_of.upgrade().map(|host| host.host_info().name).unwrap_or_default()),
        );
        host.attach_links(&links);
        Ok(Arc::new(Self { channel, host, links, network: options.network }))
    }

    /// This computer's id.
    pub fn fingerprint(&self) -> &str {
        self.channel.fingerprint()
    }

    /// The app's own routes, for paired computers' requests. Until this is
    /// called they are told the computer is starting up.
    pub fn serve(&self, api: Arc<dyn LocalApi>) {
        self.host.serve(api);
    }

    /// Applies the configuration (listens when hosting is on) and brings the
    /// link of every paired host up.
    pub async fn start(&self) {
        if self.network {
            self.host.reconcile().await;
            self.links.start();
        }
    }

    /// Closes the listener, every session and every link.
    pub fn stop(&self) {
        self.links.stop();
        self.host.stop();
    }

    /// The port the direct listener is bound to, when it listens.
    pub fn listening_port(&self) -> Option<u16> {
        self.host.status().listening.then(|| self.host.bound_port()).flatten()
    }

    async fn send(&self, host_id: &str, ready: Duration, request: LinkRequest) -> Result<link::Answer, LinkError> {
        let link = self.links.link(host_id).ok_or(LinkError::UnknownHost)?;
        let sender = link.ready(ready).await.map_err(|e| LinkError::Unavailable { code: e.code })?;
        let mut headers = request.headers;
        if request.human {
            headers.push((PEER_HUMAN_HEADER.to_owned(), "1".to_owned()));
        }
        link::send(sender, &request.method, &request.target, &headers, request.body).await.map_err(LinkError::Failed)
    }
}

impl PeerHosting for Peering {
    fn host_info(&self) -> HostInfo {
        self.host.host_info()
    }

    fn status(&self) -> PeerStatus {
        let mut status = self.host.status();
        // Hosting is on, yet nothing listens and no relay is dialled: say why,
        // and show the relay the settings name as one that is not online.
        if !self.network && status.enabled {
            status.relay = self.host.configured_relay().map(|url| PeerStatusRelay { url, online: false });
            status.off = Some(OFF_NETWORK.to_owned());
        }
        status
    }

    fn create_invite(&self) -> Result<InviteResponse, HostingOff> {
        self.host.create_invite()
    }

    fn cancel_invites(&self) -> usize {
        self.host.cancel_invites()
    }

    fn revoke(&self, fp: &str) -> bool {
        self.host.revoke(fp)
    }

    fn disconnect(&self, fp: &str) -> usize {
        self.host.disconnect(fp)
    }

    fn reconcile(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            if self.network {
                self.host.reconcile().await;
            }
        })
    }
}

impl PeerLifecycle for Peering {
    fn start(&self) -> BoxFuture<'_, ()> {
        Box::pin(Peering::start(self))
    }

    fn stop(&self) {
        Peering::stop(self);
    }

    fn kick(&self) {
        self.links.kick_all();
    }
}

impl HostLinks for Peering {
    fn list(&self) -> Vec<HostView> {
        self.links.list()
    }

    fn get(&self, id: &str) -> Option<HostView> {
        self.links.get(id)
    }

    fn pair<'a>(
        &'a self,
        invite: &'a str,
        alias: Option<&'a str>,
        mutual: bool,
    ) -> BoxFuture<'a, Result<(HostView, bool), PairingError>> {
        Box::pin(async move {
            // One pairing, both directions: the offer rides the pairing, and
            // this computer allows the other one only after it accepts.
            let offer = mutual.then(|| self.host.reciprocal_offer());
            let (pair_offer, bearer_hash) = match offer {
                Some((addrs, grant)) => {
                    let (relay, hash) = grant.map_or((None, None), |(relay, hash)| (Some(relay), Some(hash)));
                    (Some(PairOffer { addrs, relay }), hash)
                }
                None => (None, None),
            };
            let (host, accepted) = self.links.pair(invite, alias, pair_offer).await?;
            if accepted {
                self.host.allow_device(&host.id.0, &host.name, &host.platform, bearer_hash);
            }
            Ok((self.links.view(host), accepted))
        })
    }

    fn update(&self, id: &str, patch: &UpdateHostRequest) -> Option<HostView> {
        self.links.update(id, patch)
    }

    fn forget(&self, id: &str) -> bool {
        self.links.forget(id)
    }

    fn reconnect(&self, id: &str) -> bool {
        self.links.reconnect(id)
    }

    fn forward<'a>(
        &'a self,
        host_id: &'a str,
        mut request: LinkRequest,
    ) -> BoxFuture<'a, Result<PeerAnswer, LinkError>> {
        Box::pin(async move {
            // Event streams and text shrink severalfold; unpacked again here.
            request.headers.retain(|(name, _)| name != "accept-encoding");
            request.headers.push(("accept-encoding".to_owned(), "gzip".to_owned()));
            let answer = self.send(host_id, READY_TIMEOUT, request).await?;
            let gzipped = answer.headers.iter().any(|(n, v)| n == "content-encoding" && v.eq_ignore_ascii_case("gzip"));
            let headers = answer
                .headers
                .into_iter()
                .filter(|(name, _)| !DROP_RESPONSE.contains(&name.as_str()))
                .filter(|(name, _)| !(gzipped && (name == "content-encoding" || name == "content-length")))
                .collect();
            Ok(PeerAnswer { status: answer.status, headers, body: Box::new(LinkBody::new(answer.body, gzipped)) })
        })
    }
}

impl Machines for Peering {
    fn local_name(&self) -> String {
        self.host.host_info().name
    }

    fn list(&self) -> Vec<HostView> {
        self.links.list()
    }

    fn get(&self, id: &str) -> Option<HostView> {
        self.links.get(id)
    }

    fn call<'a>(
        &'a self,
        host_id: &'a str,
        request: PeerRequest,
    ) -> BoxFuture<'a, Result<PeerResponse, PeerCallError>> {
        Box::pin(async move {
            let headers = request.content_type.map(|t| ("content-type".to_owned(), t.to_owned())).into_iter().collect();
            let outgoing = LinkRequest {
                method: request.method.to_owned(),
                target: request.target,
                headers,
                body: request.body,
                // The transfer engine acts for the user of this computer.
                human: true,
            };
            let sent = self.send(host_id, Duration::from_millis(request.ready_ms), outgoing);
            let whole = async {
                let answer = sent.await.map_err(|e| match e {
                    LinkError::UnknownHost => PeerCallError::NotPaired,
                    LinkError::Unavailable { code } if code == OFF_NETWORK => PeerCallError::OffNetwork,
                    LinkError::Unavailable { .. } => PeerCallError::NotReady,
                    LinkError::Failed(_) => PeerCallError::Dropped,
                })?;
                let body: Bytes =
                    link::collect(answer.body, MAX_CALL_ANSWER_BYTES).await.map_err(|_| PeerCallError::Dropped)?;
                Ok(PeerResponse { status: answer.status, body })
            };
            // The wait for the link has its own limit; the answer gets the rest.
            let limit = Duration::from_millis(request.ready_ms.saturating_add(request.timeout_ms));
            tokio::time::timeout(limit, whole).await.unwrap_or(Err(PeerCallError::TimedOut))
        })
    }
}
