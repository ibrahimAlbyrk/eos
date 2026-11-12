//! One computer controlling another: the link, and the feature over it.

use std::path::PathBuf;
use std::sync::Arc;

use eos_core::Clock;
use eos_core::net::machines::Machines;
use eos_core::net::peer::PeerLifecycle;
use eos_core::net::relay::Relay;
use eos_core::store::ConfigSource;
use eos_domain::peer::ViewTokens;
use eos_mod_peer::{BusEvents, PeerModule, PeerParts, RouterApi, api_stamp};
use eos_peer::{Peering, PeeringOptions};
use eos_platform::DataPaths;
use eos_runtime::bus::Bus;
use eos_runtime::module::Module;
use eos_runtime::router::{RouteDef, Router};

use crate::Error;

pub(crate) struct Parts<'a> {
    pub(crate) paths: &'a DataPaths,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) config: Arc<dyn ConfigSource>,
    pub(crate) bus: Bus,
    pub(crate) view_tokens: Arc<ViewTokens>,
    /// The dashboard bundle a controlling computer loads from this one.
    pub(crate) dashboard: Option<PathBuf>,
    /// Whether this run may listen and dial (`Options::peer_network`).
    pub(crate) network: bool,
    /// The relay connection: the leg of a link when neither computer reaches
    /// the other directly. Without one links are direct or tunnelled only.
    pub(crate) relay: Option<Arc<dyn Relay>>,
}

pub(crate) struct Peer {
    peering: Arc<Peering>,
    module: Arc<PeerModule>,
}

/// Reads this computer's identity and lists (minting the identity in a data
/// folder that has none). Nothing touches the network before the module's
/// start, and never in a run that keeps off it.
pub(crate) fn build(parts: Parts<'_>) -> Result<Peer, Error> {
    let Parts { paths, clock, config, bus, view_tokens, dashboard, network, relay: relay_port } = parts;
    let (read, relay) = (config.clone(), config.clone());
    let mut options = PeeringOptions::new(
        paths.join("peer"),
        clock,
        Arc::new(move || read.current().peer.clone()),
        Arc::new(BusEvents::new(bus)),
    );
    options.api_stamp = api_stamp();
    // The phone's relay is also this computer's peering relay unless one is set.
    options.relay_url = Arc::new(move || {
        let current = relay.current();
        current.peer.relay_url.clone().or_else(|| current.remote.relay.as_ref().map(|relay| relay.url.clone()))
    });
    let bundle = dashboard.clone();
    options.serves_ui = Arc::new(move || bundle.as_ref().is_some_and(|root| root.join("index.html").is_file()));
    options.network = network;
    options.relay = relay_port;
    let peering = Peering::open(options)?;
    let module = Arc::new(PeerModule::new(PeerParts {
        hosting: peering.clone(),
        links: peering.clone(),
        lifecycle: peering.clone(),
        config,
        view_tokens,
        ui_root: dashboard,
    }));
    Ok(Peer { peering, module })
}

impl Peer {
    pub(crate) fn module(&self) -> Arc<dyn Module> {
        self.module.clone()
    }

    /// The facade on the raw-content origin.
    pub(crate) fn raw_routes(&self) -> Vec<RouteDef> {
        self.module.raw_routes()
    }

    /// The paired computers, as file transfer reaches them.
    pub(crate) fn machines(&self) -> Arc<dyn Machines> {
        self.peering.clone()
    }

    pub(crate) fn lifecycle(&self) -> Arc<dyn PeerLifecycle> {
        self.peering.clone()
    }

    /// The app's routers exist: paired computers' requests go to them.
    pub(crate) fn attach(&self, api: &Arc<Router>, raw: &Arc<Router>) {
        self.peering.serve(Arc::new(RouterApi::new(api, raw)));
    }
}
