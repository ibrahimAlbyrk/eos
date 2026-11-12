//! The phone link (`manager/remote`, `manager/routes/remote.ts`): a paired
//! phone reaches this app through a relay room, and what it asks is answered
//! by the app's own routes, called as the phone.
//!
//! - [`RemoteModule`]: Settings › Remote (`/api/remote/*`), and arming: while
//!   `config.remote.enabled` and a relay URL is set, the gateway owns this
//!   computer's room on the relay and the computer is kept awake.
//! - the gateway (`gateway`): a session per phone — the snapshot on join,
//!   `hello` / `focus` / `sub` / `control` frames, events and row patches out.
//!
//! The link exists only while the app runs. There is no pairing state beyond
//! the room's two secrets (`<home>/remote`): whoever holds the pairing code's
//! room and bearer can join until the files are replaced.
//!
//! Not enforced, as today: `config.remote.rateLimit` and
//! `inactivityLeaseMs` are read and written but nothing acts on them.

mod device;
mod dispatch;
mod frames;
mod gateway;
mod routes;

use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use eos_contracts::{EosPairLit, PairingQr};
use eos_core::net::relay::{Relay, RoomClaim};
use eos_core::os::{AwakeHold, KeepAwake};
use eos_core::store::{ConfigSource, RemoteStore, RoomSecrets};
use eos_core::{Clock, Ids};
use eos_runtime::Kernel;
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::{BoxFuture, RouteDef, Router};
use sha2::{Digest, Sha256};

pub use gateway::GatewayOptions;
use gateway::{Gateway, GatewayParts};

/// How long a pairing code says it may be shown (a guard for the eye: the
/// room and the bearer stay valid).
const QR_TTL_MS: i64 = 120_000;

/// What the feature is built from.
pub struct RemoteParts {
    pub config: Arc<dyn ConfigSource>,
    pub store: Arc<dyn RemoteStore>,
    /// How the relay is reached. `None`: this app never dials one — arming
    /// does nothing, whatever the configuration says (tests, replays, a
    /// build that must not leave the computer).
    pub relay: Option<Arc<dyn Relay>>,
    pub keep_awake: Arc<dyn KeepAwake>,
    pub kernel: Kernel,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    pub options: GatewayOptions,
}

impl std::fmt::Debug for RemoteParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteParts").field("relay", &self.relay.is_some()).finish_non_exhaustive()
    }
}

/// The gateway while armed, with what its pairing code is made of.
struct Armed {
    relay_url: String,
    secrets: RoomSecrets,
    gateway: Gateway,
    /// Sleep is held off for exactly as long as the room is owned.
    _awake: Option<Box<dyn AwakeHold>>,
}

/// What arming came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArmState {
    pub enabled: bool,
    pub armed: bool,
}

struct Shared {
    parts: RemoteParts,
    /// The app's router, handed over once it is built: the gateway's requests
    /// go to the same routes the dashboard calls.
    router: OnceLock<Arc<Router>>,
    armed: Mutex<Option<Armed>>,
}

fn sha256_hex(input: &str) -> String {
    Sha256::digest(input.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

impl Shared {
    fn armed(&self) -> MutexGuard<'_, Option<Armed>> {
        // Holds the gateway or nothing: valid after any panic.
        self.armed.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn disarm(&self) {
        // Outside the lock: giving the room up ends every session.
        let armed = self.armed().take();
        drop(armed);
    }

    /// Tears the gateway down and builds it again for the configuration as it
    /// is now: always stop before start, so arming twice never dials twice and
    /// a changed relay URL takes hold.
    fn reconcile(&self) -> ArmState {
        self.disarm();
        let remote = self.parts.config.current().remote.clone();
        let armed = if remote.enabled { self.arm(remote.relay.map(|relay| relay.url)) } else { None };
        let state = ArmState { enabled: remote.enabled, armed: armed.is_some() };
        *self.armed() = armed;
        state
    }

    fn arm(&self, relay_url: Option<String>) -> Option<Armed> {
        let Some(relay_url) = relay_url.filter(|url| !url.is_empty()) else {
            tracing::warn!("remote enabled but relay.url missing — not armed");
            return None;
        };
        let (relay, router) = (self.parts.relay.as_ref()?, self.router.get()?);
        let secrets = match self.parts.store.secrets() {
            Ok(secrets) => secrets,
            Err(error) => {
                tracing::error!(%error, "the phone link's secrets could not be read; not armed");
                return None;
            }
        };
        // The relay admits a phone that presents the bearer; it is given only
        // the hash, on every registration, so a room is never open to all.
        let allowed = vec![sha256_hex(&secrets.bearer)];
        let room = relay.host(RoomClaim {
            url: relay_url.clone(),
            room: secrets.room.clone(),
            owner: secrets.owner.clone(),
            allow: Arc::new(move || allowed.clone()),
        });
        let gateway = Gateway::start(GatewayParts {
            room,
            router: router.clone(),
            kernel: self.parts.kernel.clone(),
            clock: self.parts.clock.clone(),
            ids: self.parts.ids.clone(),
            store: self.parts.store.clone(),
            options: self.parts.options,
        });
        tracing::info!(relay = %relay_url, "remote gateway armed");
        Some(Armed { relay_url, secrets, gateway, _awake: self.parts.keep_awake.hold() })
    }

    /// The pairing code: the whole credential, minted from the armed room.
    /// `None` while not armed.
    fn pairing(&self) -> Option<PairingQr> {
        let armed = self.armed();
        let armed = armed.as_ref()?;
        Some(PairingQr {
            v: Default::default(),
            typ: EosPairLit,
            relay: armed.relay_url.clone(),
            room: armed.secrets.room.clone(),
            bearer: Some(armed.secrets.bearer.clone()),
            exp: (self.parts.clock.now_ms() + QR_TTL_MS).div_euclid(1000),
        })
    }
}

/// Settings › Remote and the phone gateway.
pub struct RemoteModule {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for RemoteModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteModule").field("armed", &self.is_armed()).finish_non_exhaustive()
    }
}

impl RemoteModule {
    pub fn new(parts: RemoteParts) -> Self {
        Self { shared: Arc::new(Shared { parts, router: OnceLock::new(), armed: Mutex::new(None) }) }
    }

    /// Hands over the app's router, once, after it was built and before the
    /// modules start. Until then nothing can be armed.
    pub fn attach_router(&self, router: Arc<Router>) {
        let _ = self.shared.router.set(router);
    }

    /// Arms or disarms for the configuration as it is now. Call inside the
    /// async runtime: arming starts the connection's tasks.
    pub fn reconcile(&self) -> ArmState {
        self.shared.reconcile()
    }

    pub fn is_armed(&self) -> bool {
        self.shared.armed().is_some()
    }

    /// Phones with a session right now.
    pub fn devices(&self) -> usize {
        self.shared.armed().as_ref().map_or(0, |armed| armed.gateway.devices())
    }
}

impl Module for RemoteModule {
    fn id(&self) -> &'static str {
        "remote"
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.shared)
    }

    /// Arms when the configuration says so, as today's start-up does.
    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            self.shared.reconcile();
            Ok(())
        })
    }

    /// Gives the room up (the relay closes its phones) and lets the computer sleep.
    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move { self.shared.disarm() })
    }
}
