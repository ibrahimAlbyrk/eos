//! Hosting: paired computers control this one.
//!
//! Owns the accepting end of the channel (a direct listener and relayed
//! pipes), the single-use invites, pairing and the list of paired devices.
//! Every stream of a paired device goes to the gateway, which hands it to the
//! app's own routes; nothing here knows about workers, files or terminals.

mod gateway;
mod respond;
pub(crate) mod server;

use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};

use eos_contracts::{
    Fingerprint, HostInfo, IntLit, InviteResponse, OpenInvite, PairRequest, PairResponse, PairedDevice,
    PairedDeviceView, PeerConfig, PeerInvite, PeerInviteRelay, PeerStatus, PeerStatusRelay, RelayGrant, peer_refusal,
};
use eos_core::net::peer::{ConnectedDevice, HostingOff, LocalApi, PeerEvents};
use eos_core::net::relay::{PipeListener, Relay, RoomClaim};
use eos_core::{BoxFuture, Clock};
use eos_domain::peer::{
    OpenInvites, PeerAdmission, Redeemed, admit_peer, bearer_hash, encode_invite, format_device_id, parse_address,
};

use self::respond::{ErrorBody, respond_json, send_head};
use self::server::{Admission, Inbound, SecureServer, SessionHandler, SessionPeer};
use crate::channel::pipe::H2Pipe;
use crate::channel::{BoxIo, Channel};
use crate::link::HostLinkService;
use crate::machine::direct_addresses;
use crate::relay_io::relay_stream;
use crate::stores::{self, OpenInviteList, PairedDevices, random_secret};

const PAIR_PATH: &str = "/peer/pair";
const REVERSE_PATH: &str = "/peer/reverse";
const MAX_PAIR_BODY_BYTES: usize = 16 * 1024;

/// Reads the configuration in force (`config.peer`).
pub type PeerConfigSource = Arc<dyn Fn() -> PeerConfig + Send + Sync>;
/// Holds system sleep off while the returned value lives (a sleeping
/// computer cannot be reached).
pub type KeepAwake = Arc<dyn Fn() -> Option<Box<dyn Send + Sync>> + Send + Sync>;

pub(crate) struct HostDeps {
    pub(crate) peer_dir: PathBuf,
    pub(crate) channel: Arc<Channel>,
    pub(crate) config: PeerConfigSource,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) events: Arc<dyn PeerEvents>,
    /// The user's home folder, for `HostInfo`.
    pub(crate) home: String,
    pub(crate) api_stamp: String,
    pub(crate) serves_ui: Arc<dyn Fn() -> bool + Send + Sync>,
    pub(crate) relay: Option<Arc<dyn Relay>>,
    /// The relay this computer is reachable through when direct paths fail.
    pub(crate) relay_url: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    /// The interface the direct listener binds; `None` is every interface.
    pub(crate) bind: Option<IpAddr>,
    /// Where devices can reach the bound port; `None` asks the system.
    pub(crate) addresses: Option<Arc<dyn Fn(u16) -> Vec<String> + Send + Sync>>,
    pub(crate) keep_awake: KeepAwake,
}

/// The room's handle is never used while the state is locked: the relay
/// may ask for the allow list from inside any call on it.
struct RelayLeg {
    url: String,
    room: String,
    handle: Arc<dyn PipeListener>,
}

impl Drop for RelayLeg {
    fn drop(&mut self) {
        // Giving the room up ends the task that takes its pipes.
        self.handle.close();
    }
}

#[derive(Default)]
struct State {
    invites: OpenInvites,
    relay: Option<RelayLeg>,
    keep_awake: Option<Box<dyn Send + Sync>>,
    awake: bool,
    /// The configured port being served, and the port actually bound (they
    /// differ when the configuration asks for any free port).
    listening_port: Option<u16>,
    bound_port: Option<u16>,
}

pub(crate) struct PeerHost {
    deps: HostDeps,
    devices: PairedDevices,
    invite_store: OpenInviteList,
    server: Arc<SecureServer>,
    state: Mutex<State>,
    /// One reconcile at a time: rapid toggles must not interleave binds.
    reconciling: tokio::sync::Mutex<()>,
    api: OnceLock<Arc<dyn LocalApi>>,
    links: OnceLock<Weak<HostLinkService>>,
    machine_name: String,
    me: Weak<PeerHost>,
}

impl std::fmt::Debug for PeerHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PeerHost").finish_non_exhaustive()
    }
}

struct Handler(Weak<PeerHost>);

impl SessionHandler for Handler {
    fn admit(&self, fingerprint: &str) -> Admission {
        self.0.upgrade().map_or(Admission::Refused(peer_refusal::HOSTING_OFF), |host| host.admit(fingerprint))
    }

    fn on_stream(&self, stream: Inbound, peer: SessionPeer) -> BoxFuture<'static, ()> {
        let host = self.0.upgrade();
        Box::pin(async move {
            if let Some(host) = host {
                host.on_stream(stream, peer).await;
            }
        })
    }

    fn on_session(&self, peer: &SessionPeer, open: bool) {
        if let Some(host) = self.0.upgrade() {
            host.on_session(peer, open);
        }
    }
}

impl PeerHost {
    pub(crate) fn new(deps: HostDeps) -> Arc<Self> {
        let devices = stores::paired_devices(&deps.peer_dir);
        let invite_store = stores::open_invites(&deps.peer_dir);
        let invites = OpenInvites::restore(invite_store.list());
        Arc::new_cyclic(|me: &Weak<PeerHost>| Self {
            server: SecureServer::new(deps.channel.clone(), Arc::new(Handler(me.clone()))),
            devices,
            invite_store,
            state: Mutex::new(State { invites, ..State::default() }),
            reconciling: tokio::sync::Mutex::new(()),
            api: OnceLock::new(),
            links: OnceLock::new(),
            machine_name: eos_platform::computer_name(),
            me: me.clone(),
            deps,
        })
    }

    /// The app's routes, once they exist.
    pub(crate) fn serve(&self, api: Arc<dyn LocalApi>) {
        let _ = self.api.set(api);
    }

    pub(crate) fn attach_links(&self, links: &Arc<HostLinkService>) {
        let _ = self.links.set(Arc::downgrade(links));
    }

    fn links(&self) -> Option<Arc<HostLinkService>> {
        self.links.get().and_then(Weak::upgrade)
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn config(&self) -> PeerConfig {
        (self.deps.config)()
    }

    pub(crate) fn host_info(&self) -> HostInfo {
        let fp = self.deps.channel.fingerprint();
        HostInfo {
            id: Fingerprint(fp.to_owned()),
            device_id: format_device_id(fp),
            name: self.config().name.unwrap_or_else(|| self.machine_name.clone()),
            platform: eos_platform::host().os().to_owned(),
            home: self.deps.home.clone(),
            api_stamp: self.deps.api_stamp.clone(),
            serves_ui: (self.deps.serves_ui)(),
        }
    }

    pub(crate) fn bound_port(&self) -> Option<u16> {
        self.state().bound_port
    }

    pub(crate) fn status(&self) -> PeerStatus {
        let cfg = self.config();
        let (leg, open_invites) = {
            let state = self.state();
            (state.relay.as_ref().map(|leg| (leg.url.clone(), leg.handle.clone())), state.invites.len())
        };
        let relay = leg.map(|(url, handle)| PeerStatusRelay { url, online: handle.online() });
        PeerStatus {
            enabled: cfg.enabled,
            direct: cfg.direct,
            port: cfg.port,
            listening: self.server.listening().is_some(),
            host: self.host_info(),
            addrs: self.current_addresses(),
            relay,
            open_invites: i64::try_from(open_invites).unwrap_or(i64::MAX),
            devices: self.devices_view(),
            off: None,
        }
    }

    /// The relay the settings name for this computer, dialled or not.
    pub(crate) fn configured_relay(&self) -> Option<String> {
        (self.deps.relay_url)()
    }

    fn devices_view(&self) -> Vec<PairedDeviceView> {
        let connected = self.server.connected();
        self.devices
            .list()
            .into_iter()
            .map(|d| PairedDeviceView {
                device_id: format_device_id(&d.fp.0),
                connected: connected.iter().any(|fp| fp.as_ref() == d.fp.0),
                fp: d.fp,
                name: d.name,
                platform: d.platform,
                paired_at: d.paired_at,
                last_seen_at: d.last_seen_at,
            })
            .collect()
    }

    pub(crate) fn create_invite(&self) -> Result<InviteResponse, HostingOff> {
        if !self.config().enabled {
            return Err(HostingOff);
        }
        let secret = random_secret(18);
        let relay = {
            let mut state = self.state();
            let ((hash, join_hash), dropped) = state.invites.open(&secret);
            for gone in &dropped {
                self.invite_store.remove(gone);
            }
            self.invite_store.upsert(OpenInvite { hash, join_hash, created_at: self.deps.clock.now_ms().into() });
            state.relay.as_ref().map(|leg| PeerInviteRelay { url: leg.url.clone(), room: leg.room.clone() })
        };
        self.refresh_relay_allow();
        let info = self.host_info();
        let link = encode_invite(&PeerInvite {
            v: IntLit,
            fp: info.id,
            sec: secret,
            name: info.name,
            addrs: self.current_addresses(),
            relay,
            exp: None,
        });
        Ok(InviteResponse { link, device_id: info.device_id })
    }

    /// Every open invite stops working — a link that went somewhere it shouldn't.
    pub(crate) fn cancel_invites(&self) -> usize {
        let gone = self.state().invites.cancel_all();
        self.forget_invites(&gone);
        gone.len()
    }

    fn forget_invites(&self, hashes: &[String]) {
        for hash in hashes {
            self.invite_store.remove(hash);
        }
        if !hashes.is_empty() {
            self.refresh_relay_allow();
        }
    }

    /// Lets a computer control this one: it redeemed an invite here, or a
    /// host this computer paired with took its reciprocal offer.
    pub(crate) fn allow_device(&self, fp: &str, name: &str, platform: &str, relay_bearer_hash: Option<String>) {
        let existing = self.devices.get(fp);
        let now = self.deps.clock.now_ms();
        // Every paired device has its own relay bearer, so revoking one device
        // closes the relay to it alone.
        let relay_bearer_hash =
            relay_bearer_hash.or_else(|| existing.as_ref().and_then(|d| d.relay_bearer_hash.clone()));
        self.devices.upsert(PairedDevice {
            fp: Fingerprint(fp.to_owned()),
            name: name.to_owned(),
            platform: platform.to_owned(),
            paired_at: existing.map_or(now.into(), |d| d.paired_at),
            last_seen_at: Some(now.into()),
            relay_bearer_hash,
        });
        self.refresh_relay_allow();
        tracing::info!(device_id = %format_device_id(fp), name, "device paired");
        self.publish_presence();
        if let Some(links) = self.links() {
            links.offer_reverse(fp);
        }
    }

    /// What this computer hands a host it pairs with so that host can control
    /// it back: its direct addresses and a relay bearer for that host alone.
    /// The bearer's hash takes effect only through `allow_device`, once the
    /// host accepts.
    pub(crate) fn reciprocal_offer(&self) -> (Vec<String>, Option<(RelayGrant, String)>) {
        (self.current_addresses(), self.mint_relay_grant())
    }

    pub(crate) fn revoke(&self, fp: &str) -> bool {
        if !self.devices.remove(fp) {
            return false;
        }
        self.refresh_relay_allow();
        self.server.disconnect(fp);
        self.publish_presence();
        tracing::info!(device_id = %format_device_id(fp), "device revoked");
        true
    }

    pub(crate) fn disconnect(&self, fp: &str) -> usize {
        self.server.disconnect(fp)
    }

    /// A relayed or tunnelled connection enters the same TLS code as a direct one.
    pub(crate) fn accept_pipe(&self, io: BoxIo) {
        self.server.accept(io);
    }

    pub(crate) fn allows_control_from(&self, fp: &str) -> bool {
        self.config().enabled && self.devices.get(fp).is_some()
    }

    /// Who the relay may admit into this computer's room: paired devices by
    /// their own bearer and — only while an invite is open — a device
    /// redeeming it.
    fn relay_allow(&self) -> Vec<String> {
        let mut allow: Vec<String> = self.devices.list().into_iter().filter_map(|d| d.relay_bearer_hash).collect();
        allow.extend(self.state().invites.join_hashes().map(str::to_owned));
        allow
    }

    fn refresh_relay_allow(&self) {
        let handle = self.state().relay.as_ref().map(|leg| leg.handle.clone());
        if let Some(handle) = handle {
            handle.refresh_allow();
        }
    }

    /// Applies `config.peer`: listen when hosting and direct are on, drop
    /// everything when hosting is off.
    pub(crate) async fn reconcile(&self) {
        let _one_at_a_time = self.reconciling.lock().await;
        let cfg = self.config();
        if !cfg.enabled {
            let gone = self.state().invites.cancel_all();
            for hash in &gone {
                self.invite_store.remove(hash);
            }
            self.server.disconnect_all();
        }
        self.apply_relay(cfg.enabled);
        let newly_on = {
            let mut state = self.state();
            if cfg.enabled && !state.awake {
                state.awake = true;
                state.keep_awake = (self.deps.keep_awake)();
                true
            } else {
                if !cfg.enabled && state.awake {
                    state.awake = false;
                    state.keep_awake = None;
                }
                false
            }
        };
        if newly_on && let Some(links) = self.links() {
            for device in self.devices.list() {
                links.offer_reverse(&device.fp.0);
            }
        }

        let want = (cfg.enabled && cfg.direct).then(|| u16::try_from(cfg.port).unwrap_or(0));
        if self.server.listening().is_some() && self.state().listening_port == want {
            return;
        }
        self.server.unlisten();
        {
            let mut state = self.state();
            state.listening_port = None;
            state.bound_port = None;
        }
        let Some(port) = want else { return };
        match self.server.listen(port, self.deps.bind).await {
            Ok(addr) => {
                let mut state = self.state();
                state.listening_port = Some(port);
                state.bound_port = Some(addr.port());
                tracing::info!(port = addr.port(), "listening for paired devices");
            }
            Err(e) => tracing::warn!(port, error = %e, "direct listener failed — relay only"),
        }
    }

    pub(crate) fn stop(&self) {
        let (awake, relay) = {
            let mut state = self.state();
            state.awake = false;
            (state.keep_awake.take(), state.relay.take())
        };
        drop((awake, relay));
        self.server.close();
    }

    /// One relay leg while hosting is on and a relay is configured; a changed
    /// address or room rebuilds it.
    fn apply_relay(&self, hosting: bool) {
        let room = match (&self.deps.relay, hosting.then(|| (self.deps.relay_url)()).flatten()) {
            (Some(_), Some(url)) => match stores::load_or_create_relay_room(&self.deps.peer_dir) {
                Ok((room, owner)) => Some((url, room, owner)),
                Err(e) => {
                    tracing::warn!(error = %e, "the relay room could not be read");
                    None
                }
            },
            _ => None,
        };
        let previous = {
            let mut state = self.state();
            if let (Some(current), Some((url, room, _))) = (&state.relay, &room)
                && current.url == *url
                && current.room == *room
            {
                return;
            }
            state.relay.take()
        };
        drop(previous);
        let (Some(relay), Some((url, room, owner))) = (&self.deps.relay, room) else { return };
        let allow_from = self.me.clone();
        let handle = relay.listen(RoomClaim {
            url: url.clone(),
            room: room.clone(),
            owner,
            allow: Arc::new(move || allow_from.upgrade().map(|host| host.relay_allow()).unwrap_or_default()),
        });
        // Every device the relay admits enters the same TLS code as a direct one.
        let (pipes, host) = (handle.clone(), self.me.clone());
        tokio::spawn(async move {
            while let Some(pipe) = pipes.accept().await {
                let Some(host) = host.upgrade() else { break };
                host.accept_pipe(relay_stream(pipe));
            }
        });
        tracing::info!(%url, "reachable through relay");
        self.state().relay = Some(RelayLeg { url, room, handle });
    }

    fn current_addresses(&self) -> Vec<String> {
        let port = match (self.server.listening(), self.state().bound_port) {
            (Some(_), Some(port)) => port,
            _ => return Vec::new(),
        };
        let advertised = self.config().advertise.unwrap_or_default();
        let mut out: Vec<String> = Vec::new();
        let found = match &self.deps.addresses {
            Some(addresses) => addresses(port),
            None => direct_addresses(port),
        };
        // "host" alone means the listening port.
        let named = advertised.into_iter().map(|a| if parse_address(&a).is_some() { a } else { format!("{a}:{port}") });
        for addr in named.chain(found) {
            if !out.contains(&addr) {
                out.push(addr);
            }
        }
        out
    }

    fn mint_relay_grant(&self) -> Option<(RelayGrant, String)> {
        let state = self.state();
        let leg = state.relay.as_ref()?;
        let bearer = random_secret(32);
        let hash = bearer_hash(&bearer);
        Some((RelayGrant { url: leg.url.clone(), room: leg.room.clone(), bearer }, hash))
    }

    fn admit(&self, fingerprint: &str) -> Admission {
        if !self.config().enabled {
            return Admission::Refused(peer_refusal::HOSTING_OFF);
        }
        let pairing_open = !self.state().invites.is_empty();
        match admit_peer(self.devices.get(fingerprint).is_some(), pairing_open) {
            PeerAdmission::Trusted => Admission::Trusted,
            PeerAdmission::PairingOnly => Admission::PairingOnly,
            PeerAdmission::Refused => Admission::Refused(peer_refusal::NOT_PAIRED),
        }
    }

    async fn on_stream(&self, stream: Inbound, peer: SessionPeer) {
        if stream.method == "POST" && stream.target == PAIR_PATH {
            self.pair(stream, &peer).await;
            return;
        }
        // Trust is read again for every stream: a revoked device's session gets
        // nothing more even before its teardown lands.
        if !self.allows_control_from(&peer.fingerprint) {
            respond_json(stream.respond, 403, &ErrorBody { error: "this device is not paired" }).await;
            return;
        }
        if stream.method == "POST" && stream.target == REVERSE_PATH {
            self.take_reverse(stream, &peer.fingerprint).await;
            return;
        }
        match self.api.get() {
            Some(api) => gateway::forward(api.as_ref(), stream, &peer.fingerprint).await,
            None => gateway::unavailable(stream).await,
        }
    }

    /// The stream itself becomes the byte pipe: this computer dials the
    /// device's TLS server through it, pinned like any other route.
    async fn take_reverse(&self, mut stream: Inbound, fp: &str) {
        let Some(link) = self.links().and_then(|links| links.link(fp)) else {
            respond_json(stream.respond, 404, &ErrorBody { error: "this Mac doesn't control that one" }).await;
            return;
        };
        let Some(send) = send_head(&mut stream.respond, 200, &[], false) else { return };
        link.add_reverse(Box::new(H2Pipe::new(send, stream.body)));
    }

    async fn pair(&self, mut stream: Inbound, peer: &SessionPeer) {
        let body = match crate::channel::h2util::read_up_to(&mut stream.body, MAX_PAIR_BODY_BYTES).await {
            Ok(Some(body)) => body,
            Ok(None) => return respond_json(stream.respond, 400, &ErrorBody { error: "body too large" }).await,
            Err(_) => return,
        };
        let raw: &[u8] = if body.is_empty() { b"{}" } else { &body };
        let outcome: Result<PairResponse, (u16, &'static str)> = (|| {
            let json: serde_json::Value = serde_json::from_slice(raw).map_err(|_| (400, "body is not JSON"))?;
            let request: PairRequest = eos_contracts::parse(&json).map_err(|_| (400, "invalid pair request"))?;
            if !self.redeem(&request.secret) {
                return Err((403, "invite is invalid, already used or cancelled — make a new one on that Mac"));
            }
            let grant = self.mint_relay_grant();
            let fp = peer.fingerprint.as_ref();
            // The device lets this computer control it too: remember it as a host.
            let controls_back = match (&request.reciprocal, self.links()) {
                (Some(offer), Some(links)) => {
                    links.adopt_reciprocal(
                        fp,
                        &request.name,
                        &request.platform,
                        offer.addrs.clone(),
                        offer.relay.clone(),
                    );
                    true
                }
                _ => false,
            };
            let (relay, hash) = grant.map_or((None, None), |(relay, hash)| (Some(relay), Some(hash)));
            self.allow_device(fp, &request.name, &request.platform, hash);
            Ok(PairResponse { host: self.host_info(), relay, reciprocal: controls_back.then_some(true) })
        })();
        match outcome {
            Ok(response) => respond_json(stream.respond, 200, &response).await,
            Err((status, error)) => respond_json(stream.respond, status, &ErrorBody { error }).await,
        }
    }

    fn redeem(&self, secret: &str) -> bool {
        let redeemed = self.state().invites.redeem(secret);
        match redeemed {
            Redeemed::Taken(hash) => {
                self.forget_invites(&[hash]);
                true
            }
            Redeemed::Wrong => false,
            Redeemed::Burned(gone) => {
                self.forget_invites(&gone);
                tracing::warn!("too many failed pairing attempts — open invites burned");
                false
            }
        }
    }

    fn on_session(&self, peer: &SessionPeer, open: bool) {
        let Some(device) = self.devices.get(&peer.fingerprint) else { return };
        self.devices.upsert(PairedDevice { last_seen_at: Some(self.deps.clock.now_ms().into()), ..device });
        tracing::info!(
            device_id = %format_device_id(&peer.fingerprint),
            "device {}",
            if open { "connected" } else { "disconnected" }
        );
        self.publish_presence();
    }

    fn publish_presence(&self) {
        let connected = self.server.connected();
        let devices = self
            .devices
            .list()
            .into_iter()
            .filter(|d| connected.iter().any(|fp| fp.as_ref() == d.fp.0))
            .map(|d| ConnectedDevice { device_id: format_device_id(&d.fp.0), fp: d.fp.0, name: d.name })
            .collect();
        self.deps.events.presence(devices);
    }
}
