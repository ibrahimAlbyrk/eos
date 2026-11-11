//! Pages: markdown notes the user and agents share (`<home>/pages`).
//!
//! - [`PageService`] is the one write path: every change bumps the page's
//!   revision and announces `pages:change`.
//! - [`PageDesk`] is what a caller sees of it: the routes and the agent
//!   tools ([`PageEditor`](eos_core::pages::PageEditor)) answer alike.
//! - A page linked to a chat outlives it: removing the agent only unlinks
//!   the page.

mod desk;
mod routes;
mod service;

use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::builtin_plugins::ids as plugins;
use eos_contracts::stream::topics;
use eos_contracts::{Page, PageChangeEvent};
use eos_core::pages::{PageEditor, PageSync};
use eos_core::store::{PageStore, Store};
use eos_core::{Clock, Ids};
use eos_runtime::bus::{Bus, Subscription, Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError, Opaque, SyncContribution};
use eos_runtime::router::{BoxFuture, RouteDef};
use serde::Deserialize;

pub use desk::{PageCaller, PageDesk};
pub use service::{NewPage, PageSave, PageService, summarize_page};

pub const PAGES_CHANGE: Topic<PageChangeEvent> = Topic::new(topics::PAGES_CHANGE);

#[derive(Debug, Clone, thiserror::Error)]
pub enum Error {
    /// The page changed since the revision the caller edited. Carries the
    /// page as it is now, for the caller to merge with.
    #[error("page {} changed since the revision you edited (now rev {})", .0.id.0, .0.rev)]
    Stale(Arc<Page>),
    #[error(transparent)]
    Core(#[from] eos_core::Error),
}

/// For a caller that has no use for the current page (an agent tool).
impl From<Error> for eos_core::Error {
    fn from(error: Error) -> Self {
        match error {
            Error::Stale(_) => eos_core::Error::Conflict(error.to_string()),
            Error::Core(e) => e,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerRemoved {
    worker_id: String,
}

pub struct PagesModule {
    desk: Arc<PageDesk>,
    bus: Bus,
    worker_removed: Mutex<Option<Subscription>>,
}

impl std::fmt::Debug for PagesModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PagesModule").finish_non_exhaustive()
    }
}

impl PagesModule {
    /// `pages`: the page files; `store`: the database, for the worker rows
    /// that say which chat and project an agent belongs to.
    pub fn new(
        pages: Arc<dyn PageStore>,
        store: Arc<dyn Store>,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn Ids>,
        bus: Bus,
    ) -> Self {
        let service = Arc::new(PageService::new(pages, clock, ids, bus.clone()));
        Self { desk: Arc::new(PageDesk::new(service, store)), bus, worker_removed: Mutex::new(None) }
    }

    /// Pages for the agent tools.
    pub fn editor(&self) -> Arc<dyn PageEditor> {
        self.desk.clone()
    }

    /// Pages for the sync feature.
    pub fn sync_target(&self) -> Arc<dyn PageSync> {
        self.desk.pages.clone()
    }
}

impl Module for PagesModule {
    fn id(&self) -> &'static str {
        "pages"
    }

    fn plugin(&self) -> Option<&'static str> {
        Some(plugins::PAGES)
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.desk)
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![PAGES_CHANGE.decl()]
    }

    /// The handle is an `Arc<dyn PageSync>`: the sync feature builds its page
    /// domain over it (a page's project travels as its repository key).
    fn sync(&self) -> Vec<SyncContribution> {
        let handle: Opaque = Arc::new(self.sync_target());
        vec![SyncContribution { domain: "page", handle, change_topic: Some(PAGES_CHANGE.name()), is_local: None }]
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        let pages = self.desk.pages.clone();
        let subscription = self.bus.on(topics::WORKER_REMOVED, move |event| {
            let Ok(removed) = event.payload_as::<WorkerRemoved>() else { return };
            if !pages.links_agent(&removed.worker_id) {
                return;
            }
            // Rewriting page files must not hold up the delivery of events.
            let pages = pages.clone();
            let unlink = move || {
                if let Err(e) = pages.unlink_agent(&removed.worker_id) {
                    tracing::warn!(error = %e, "pages of a removed chat were not unlinked");
                }
            };
            if let Err(e) = std::thread::Builder::new().name("pages-unlink".to_owned()).spawn(unlink) {
                tracing::warn!(error = %e, "pages of a removed chat were not unlinked");
            }
        });
        *self.worker_removed.lock().unwrap_or_else(PoisonError::into_inner) = Some(subscription);
        Box::pin(std::future::ready(Ok(())))
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        self.worker_removed.lock().unwrap_or_else(PoisonError::into_inner).take();
        Box::pin(std::future::ready(()))
    }
}
