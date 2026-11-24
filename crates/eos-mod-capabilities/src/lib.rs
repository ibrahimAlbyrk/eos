//! Capabilities: what Eos can reach for the user (GitHub, Mail, a package
//! the Forge built), over the capability service (`eos_capabilities`).
//! These are the dashboard's routes:
//!
//! - `GET /api/capabilities`: one row per capability, with its state, what
//!   it is for and the routines that use it;
//! - `GET /api/capabilities/:id`: the row, its actions, what it may reach,
//!   its secrets as set or not (never their values), its settings, its
//!   versions and its recent calls;
//! - `POST …/enable` and `…/disable`: switch it on and off;
//! - `PUT …/settings` `{values}`: its settings, from this computer only;
//! - `POST …/check`: runs its health check now;
//! - `POST …/rollback` `{version}` and `DELETE /api/capabilities/:id`: go
//!   back to a version kept here, or remove it (to the trash, its secrets
//!   kept), from this computer only;
//! - `GET /api/capabilities/candidates?item=&q=&limit=`: the items the
//!   capabilities offer to pick, newest first;
//! - `POST`, `GET`, `DELETE …/sign-in`: sign in to a capability by a code on
//!   the service's own page (GitHub), from this computer only: start it and
//!   get the code, see how it stands, end it.
//!
//! A change of a capability's state or version is announced on
//! `capabilities:change` from the write job that made it. Once the app is
//! ready, the service starts and every capability is checked hourly, spread
//! over the hour, and early after a call the service refused for its
//! sign-in or whose answer broke its shape.
//!
//! Logs carry ids, states, outcomes and durations; never settings, labels,
//! sign-in codes, tokens, input or output.

mod routes;
mod sign_in;
mod ticker;

use std::sync::Arc;

use eos_capabilities::{CAPABILITIES_CHANGE, CapabilityService};
use eos_contracts::CapabilitiesChange;
use eos_core::store::Store;
use eos_core::{BoxFuture, Clock, Sleeper};
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError};
use eos_runtime::router::RouteDef;

pub use sign_in::SIGN_IN_LINK;
pub use ticker::{CHECK_EVERY_MS, TICK_MS};

pub const CAPABILITIES_CHANGE_TOPIC: Topic<CapabilitiesChange> = Topic::new(CAPABILITIES_CHANGE);

pub struct CapabilitiesModule {
    service: Arc<CapabilityService>,
    store: Arc<dyn Store>,
    clock: Arc<dyn Clock>,
    sleeper: Arc<dyn Sleeper>,
    ticker: ticker::Ticker,
    sign_ins: Arc<sign_in::SignIns>,
}

impl std::fmt::Debug for CapabilitiesModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CapabilitiesModule").finish_non_exhaustive()
    }
}

impl CapabilitiesModule {
    /// `store`: where the routines that use a capability, its versions and
    /// its recent calls are read.
    pub fn new(
        service: Arc<CapabilityService>,
        store: Arc<dyn Store>,
        clock: Arc<dyn Clock>,
        sleeper: Arc<dyn Sleeper>,
    ) -> Self {
        let sign_ins = Arc::new(sign_in::SignIns::new(clock.clone()));
        Self { service, store, clock, sleeper, ticker: ticker::Ticker::default(), sign_ins }
    }
}

impl CapabilitiesModule {
    /// What takes a sign-in's `eos://sign-in/<id>` link back.
    pub fn sign_in_links(&self) -> SignInLinks {
        SignInLinks { sign_ins: self.sign_ins.clone(), service: self.service.clone() }
    }
}

/// Hands an `eos://sign-in/<id>` link to the attempt that waits for it.
#[derive(Clone)]
pub struct SignInLinks {
    sign_ins: Arc<sign_in::SignIns>,
    service: Arc<CapabilityService>,
}

impl std::fmt::Debug for SignInLinks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SignInLinks").finish_non_exhaustive()
    }
}

impl SignInLinks {
    /// Whether `link` was a sign-in's link back that an attempt waited for.
    /// Any other link is not one; a link that matches no attempt is dropped.
    pub fn open(&self, link: &str) -> bool {
        link.starts_with(SIGN_IN_LINK) && self.sign_ins.link(&self.service, link)
    }
}

impl Module for CapabilitiesModule {
    fn id(&self) -> &'static str {
        "capabilities"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![CAPABILITIES_CHANGE_TOPIC.decl()]
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.service, &self.store, &self.sign_ins)
    }

    /// Sweeps what an interrupted install left and gives each built-in its
    /// row before the first check: never twice on one data folder.
    fn after_ready(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            self.service.start().await?;
            self.ticker.start(self.service.clone(), self.store.clone(), self.clock.clone(), self.sleeper.clone());
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        self.sign_ins.stop();
        Box::pin(self.ticker.stop())
    }
}
