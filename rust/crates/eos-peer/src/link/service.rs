//! The hosts this computer controls (`manager/peer/HostLinkService.ts`): the
//! Machines menu.
//!
//! Pairs with a host from an invite, remembers it, and keeps one background
//! link per paired host — so the menu shows live state for hosts whose window
//! is not open, and switching to one is instant.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use bytes::Bytes;
use eos_contracts::{
    Fingerprint, HostView, KnownHost, LinkRoute, LinkState, LinkStatus, PairRequest, PairRequestReciprocal,
    PairResponse, PeerInvite, RelayGrant, UpdateHostRequest,
};
use eos_core::net::peer::PairingError;
use eos_core::net::relay::RoomJoin;
use eos_domain::peer::{
    InviteState, decode_invite, explain_dial_failures, format_device_id, invite_state, parse_address, relay_join_bearer,
};
use tokio::task::AbortHandle;

use super::dial::{Attempt, Via, race};
use super::{HostLink, LinkDeps, request};
use crate::channel::goaway::GoAwayTap;
use crate::channel::h2util::client_handshake;
use crate::machine::network_fingerprint;

const PAIR_TIMEOUT: Duration = Duration::from_secs(10);
const NETWORK_POLL: Duration = Duration::from_secs(3);
const PAIR_PATH: &str = "/peer/pair";

/// "Let it control this computer too", sent with a pairing: this computer's
/// own ways in.
pub(crate) struct PairOffer {
    pub(crate) addrs: Vec<String>,
    pub(crate) relay: Option<RelayGrant>,
}

fn pairing(status: u16, message: impl Into<String>) -> PairingError {
    PairingError { status, message: message.into() }
}

pub(crate) struct HostLinkService {
    deps: Arc<LinkDeps>,
    /// How this computer introduces itself to a host it pairs with.
    device_name: Arc<dyn Fn() -> String + Send + Sync>,
    links: Mutex<HashMap<String, Arc<HostLink>>>,
    network_watch: Mutex<Option<AbortHandle>>,
}

impl std::fmt::Debug for HostLinkService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostLinkService").finish_non_exhaustive()
    }
}

impl HostLinkService {
    pub(crate) fn new(deps: Arc<LinkDeps>, device_name: Arc<dyn Fn() -> String + Send + Sync>) -> Arc<Self> {
        Arc::new(Self { deps, device_name, links: Mutex::new(HashMap::new()), network_watch: Mutex::new(None) })
    }

    fn links(&self) -> MutexGuard<'_, HashMap<String, Arc<HostLink>>> {
        self.links.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn start(self: &Arc<Self>) {
        for host in self.deps.hosts.list() {
            self.ensure_link(&host.id.0).start();
        }
        let service = Arc::downgrade(self);
        let watch = tokio::spawn(async move {
            let mut last = network_fingerprint();
            loop {
                tokio::time::sleep(NETWORK_POLL).await;
                let Some(service) = service.upgrade() else { return };
                let now = network_fingerprint();
                if now != last {
                    last = now;
                    tracing::info!("network changed — re-probing links");
                    service.kick_all();
                }
            }
        });
        if let Some(previous) =
            self.network_watch.lock().unwrap_or_else(PoisonError::into_inner).replace(watch.abort_handle())
        {
            previous.abort();
        }
    }

    pub(crate) fn stop(&self) {
        if let Some(watch) = self.network_watch.lock().unwrap_or_else(PoisonError::into_inner).take() {
            watch.abort();
        }
        let links: Vec<Arc<HostLink>> = self.links().drain().map(|(_, link)| link).collect();
        for link in links {
            link.stop();
        }
    }

    pub(crate) fn kick_all(&self) {
        let links: Vec<Arc<HostLink>> = self.links().values().cloned().collect();
        for link in links {
            link.kick();
        }
    }

    /// The link of a host this computer controls; `None` for any other id.
    pub(crate) fn link(&self, id: &str) -> Option<Arc<HostLink>> {
        self.deps.hosts.get(id).map(|_| self.ensure_link(id))
    }

    fn existing(&self, id: &str) -> Option<Arc<HostLink>> {
        self.links().get(id).cloned()
    }

    fn ensure_link(&self, id: &str) -> Arc<HostLink> {
        self.links().entry(id.to_owned()).or_insert_with(|| HostLink::new(id, self.deps.clone())).clone()
    }

    pub(crate) fn list(&self) -> Vec<HostView> {
        self.deps.hosts.list().into_iter().map(|h| self.view(h)).collect()
    }

    pub(crate) fn get(&self, id: &str) -> Option<HostView> {
        self.deps.hosts.get(id).map(|h| self.view(h))
    }

    /// Redeems an invite: proves the host is who the invite names, hands it
    /// the single-use secret, and remembers it with whatever relay admission
    /// it grants. Answers the host and whether it took the reciprocal offer.
    pub(crate) async fn pair(
        &self,
        invite_link: &str,
        alias: Option<&str>,
        reciprocal: Option<PairOffer>,
    ) -> Result<(KnownHost, bool), PairingError> {
        let invite = decode_invite(invite_link).map_err(|e| pairing(400, e.to_string()))?;
        if invite_state(&invite, self.deps.clock.now_ms()) == InviteState::Expired {
            return Err(pairing(410, "this invite has expired — make a new one on that Mac"));
        }
        if invite.fp.0 == self.deps.channel.fingerprint() {
            return Err(pairing(400, "that invite is from this Mac"));
        }
        if !self.deps.network {
            return Err(pairing(503, "this run of Eos keeps off the network"));
        }
        let offered = reciprocal.is_some();
        let request = PairRequest {
            secret: invite.sec.clone(),
            name: (self.device_name)(),
            platform: eos_platform::host().os().to_owned(),
            reciprocal: reciprocal.map(|offer| PairRequestReciprocal { addrs: offer.addrs, relay: offer.relay }),
        };
        let (status, body) = self.post_pair(&invite, &request).await?;
        if status != 200 {
            let said = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|json| json.get("error").and_then(|e| e.as_str()).map(str::to_owned));
            let message = said.unwrap_or_else(|| format!("pairing failed ({status})"));
            return Err(pairing(if status == 403 { 403 } else { 502 }, message));
        }
        let incompatible = || pairing(502, "that Mac answered with an incompatible Eos version");
        let json: serde_json::Value = serde_json::from_slice(&body).map_err(|_| incompatible())?;
        let response: PairResponse = eos_contracts::parse(&json).map_err(|_| incompatible())?;
        let host = self.remember(KnownHost {
            id: invite.fp,
            name: response.host.name,
            alias: alias.map(str::trim).filter(|a| !a.is_empty()).map(str::to_owned),
            platform: response.host.platform,
            addrs: invite.addrs,
            relay: response.relay,
            paired_at: 0.into(),
            last_connected_at: Some(self.deps.clock.now_ms().into()),
        });
        Ok((host, offered && response.reciprocal == Some(true)))
    }

    /// Opens a session to the inviting host over any route the invite names
    /// and posts the pair request on it.
    async fn post_pair(&self, invite: &PeerInvite, request: &PairRequest) -> Result<(u16, Bytes), PairingError> {
        let mut attempts: Vec<Attempt> = invite
            .addrs
            .iter()
            .filter_map(|addr| parse_address(addr))
            .map(|target| Attempt { delay: Duration::ZERO, route: LinkRoute::Direct, via: Via::Direct(target) })
            .collect();
        // Over the relay the room admits this computer, for as long as the
        // invite is open, by a bearer derived from its secret — the secret
        // itself only ever crosses inside TLS.
        if let (Some(_), Some(relay)) = (&self.deps.relay, &invite.relay) {
            attempts.push(Attempt {
                delay: Duration::ZERO,
                route: LinkRoute::Relay,
                via: Via::Relay(RoomJoin {
                    url: relay.url.clone(),
                    room: relay.room.clone(),
                    bearer: relay_join_bearer(&invite.sec),
                }),
            });
        }
        if attempts.is_empty() {
            return Err(pairing(
                502,
                "that Mac offers no way in — turn on \"Direct on this network\" or set a relay there",
            ));
        }
        let raced = race(&self.deps.channel, self.deps.relay.as_ref(), &invite.fp.0, attempts, PAIR_TIMEOUT).await;
        let (tls, _) = raced.map_err(|failures| {
            if failures.iter().any(|f| f.identity) {
                return pairing(403, "the Mac at that address is not the one that made the invite");
            }
            if failures.iter().any(super::dial::Failed::relay_denied) {
                return pairing(410, "the relay no longer accepts this invite — make a new one on that Mac");
            }
            let reasons: Vec<_> = failures.into_iter().map(|f| f.failure).collect();
            tracing::warn!(host = %invite.name, failures = ?reasons, "pairing found no route to that Mac");
            pairing(502, format!("couldn't reach that Mac: {}", explain_dial_failures(&reasons)))
        })?;

        let (tap, goaway) = GoAwayTap::new(tls);
        let unreachable = |e: String| pairing(502, e);
        let (sender, connection) = client_handshake(tap).await.map_err(|e| unreachable(e.to_string()))?;
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        });
        let body = Bytes::from(serde_json::to_vec(request).unwrap_or_default());
        let headers = [("content-type".to_owned(), "application/json".to_owned())];
        let exchange = async {
            let answer = request::send(sender, "POST", PAIR_PATH, &headers, body).await?;
            let body = request::collect(answer.body, 64 * 1024).await?;
            Ok::<_, String>((answer.status, body))
        };
        let outcome = tokio::time::timeout(PAIR_TIMEOUT, exchange).await;
        driver.abort();
        match outcome {
            Err(_) => Err(pairing(504, "that Mac didn't answer")),
            Ok(Ok(answered)) => Ok(answered),
            // With no invite open the host turns the session away (GOAWAY)
            // instead of answering: the invite was used or cancelled.
            Ok(Err(_)) if goaway.get().is_some() => Err(pairing(
                403,
                "that Mac isn't taking this invite — it was already used or cancelled; make a new one there",
            )),
            Ok(Err(e)) => Err(unreachable(e)),
        }
    }

    /// A device pairing with this computer lets this computer control it too:
    /// remember it like a host paired through an invite, and bring its link up.
    pub(crate) fn adopt_reciprocal(
        &self,
        fp: &str,
        name: &str,
        platform: &str,
        addrs: Vec<String>,
        relay: Option<RelayGrant>,
    ) {
        self.remember(KnownHost {
            id: Fingerprint(fp.to_owned()),
            name: name.to_owned(),
            alias: None,
            platform: platform.to_owned(),
            addrs,
            relay,
            paired_at: 0.into(),
            last_connected_at: None,
        });
    }

    /// Saves a paired host (keeping what the person set before) and
    /// (re)starts its link. `paired_at` is set here.
    fn remember(&self, given: KnownHost) -> KnownHost {
        let existing = self.deps.hosts.get(&given.id.0);
        let before = existing.as_ref();
        let host = KnownHost {
            alias: given.alias.filter(|a| !a.is_empty()).or_else(|| before.and_then(|h| h.alias.clone())),
            relay: given.relay.or_else(|| before.and_then(|h| h.relay.clone())),
            paired_at: before.map_or(self.deps.clock.now_ms().into(), |h| h.paired_at),
            last_connected_at: given.last_connected_at.or_else(|| before.and_then(|h| h.last_connected_at)),
            ..given
        };
        self.deps.hosts.upsert(host.clone());
        let link = self.ensure_link(&host.id.0);
        link.stop();
        link.start();
        self.deps.events.host_changed(&host.id.0);
        tracing::info!(host = %host.name, device_id = %format_device_id(&host.id.0), "paired with host");
        host
    }

    pub(crate) fn update(&self, id: &str, patch: &UpdateHostRequest) -> Option<HostView> {
        let host = self.deps.hosts.get(id)?;
        let next = KnownHost {
            alias: match &patch.alias {
                Some(alias) => alias.as_deref().map(str::trim).filter(|a| !a.is_empty()).map(str::to_owned),
                None => host.alias.clone(),
            },
            addrs: patch.addrs.clone().unwrap_or_else(|| host.addrs.clone()),
            ..host
        };
        self.deps.hosts.upsert(next.clone());
        if patch.addrs.is_some()
            && let Some(link) = self.existing(id)
        {
            link.kick();
        }
        self.deps.events.host_changed(id);
        Some(self.view(next))
    }

    pub(crate) fn forget(&self, id: &str) -> bool {
        let removed = self.deps.hosts.remove(id);
        if let Some(link) = self.links().remove(id) {
            link.stop();
        }
        if removed {
            self.deps.events.host_changed(id);
        }
        removed
    }

    /// That host may now control this computer: offer it a way back through its link.
    pub(crate) fn offer_reverse(&self, id: &str) {
        if let Some(link) = self.existing(id) {
            link.offer_reverse();
        }
    }

    pub(crate) fn reconnect(&self, id: &str) -> bool {
        let Some(link) = self.link(id) else { return false };
        if link.status().state == LinkState::Unauthorized {
            link.stop();
            link.start();
        } else {
            link.kick();
        }
        true
    }

    pub(crate) fn view(&self, host: KnownHost) -> HostView {
        let link = self.existing(&host.id.0);
        let offline = || LinkStatus {
            state: LinkState::Offline,
            route: None,
            rtt_ms: None,
            since: self.deps.clock.now_ms().into(),
            attempt: 0,
            error: None,
        };
        HostView {
            device_id: format_device_id(&host.id.0),
            has_relay: host.relay.is_some(),
            link: link.as_ref().map_or_else(offline, |l| l.status()),
            info: link.and_then(|l| l.info()),
            id: host.id,
            name: host.name,
            alias: host.alias,
            platform: host.platform,
            addrs: host.addrs,
            paired_at: host.paired_at,
            last_connected_at: host.last_connected_at,
        }
    }
}
