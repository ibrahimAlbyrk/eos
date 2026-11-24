//! Routine surfaces: the interfaces a run answers with outside a chat.
//!
//! - `GET /api/surfaces?routine=&place=`: the surfaces not archived;
//! - `GET /api/surfaces/:id`, `…/versions`, `…/versions/:version`: one
//!   surface, its designs newest first, one design with its body;
//! - `GET /api/surfaces/:id/issues?before=&limit=`, `…/issues/:issueId`: the
//!   answers its routine's runs gave, newest first; a View issue is made by a
//!   run's `return_view` ([`SurfacesModule::tools`]);
//! - `GET /api/surfaces/:id/issues/:issueId/document?mode=phone|share` and
//!   `…/mail`: a page issue with no script, for the phone or a file to
//!   share, and as the mail it is sent as ([`SurfacesModule::render`]);
//! - `PUT /api/surfaces/:id/issues/:issueId/fields` and `POST …/read`: an
//!   edit in place a page's contract allows, kept as a revision with its
//!   before and after, and what the reader opened, each told to memory;
//! - `GET /api/surfaces/:id/queries/:queryId?args=` and
//!   `…/issues/:issueId/parts/:part`: a named query its design reads, and a
//!   Live part drawn with its answer, each naming the topics that change it;
//! - `GET`/`PUT /api/surfaces/:id/state?scope=`: its small saved state, for
//!   the whole surface or one of its issues, announced on `surfaces:state`;
//! - on the raw-content origin ([`SurfacesModule::raw_routes`]), a page
//!   issue drawn in its frame, its images and the page probe's documents;
//! - `GET`/`PUT /api/surfaces/pins` and `GET /api/surfaces/tiles`: up to
//!   three surfaces pinned on this Mac's Home, announced on `surfaces:pins`,
//!   and each as its tile shows it;
//! - `GET`/`PUT /api/settings/surfaces`: how surfaces read on this Mac, kept
//!   in `settings.json` under keys only that route writes;
//! - `GET /api/actions`, `POST /api/actions/run`, `GET /api/actions/records/:id`:
//!   the direct actions, a press of a button through the dispatcher (also
//!   the [`DirectActions`](eos_core::surface::DirectActions) port), and its
//!   record, announced on `actions:record`. Surfaces offer
//!   `surface.keep_issue` themselves.
//!
//! A routine's surface is made, kept, archived and restored with it by the
//! [`SurfaceAuthor`] the routines feature holds.
//!
//! Surfaces belong to routines and hold the user's data: a surface's reads
//! are open to the user's own pages and the phone, its state to the user's
//! dashboard and the phone. Logs carry ids, levels, places and sizes, never
//! a title, a body or state.

mod action_routes;
mod authoring;
mod builtins;
mod dispatch;
mod edits;
mod export;
mod fill;
mod issue_routes;
mod issues;
mod page;
mod page_press;
mod pins;
mod queries;
mod raw;
mod records;
mod retention;
mod routes;
mod settings;
mod tiles;
mod wire;

use std::sync::Arc;

use eos_contracts::{ActionsRecord, SurfacesChange, SurfacesIssue, SurfacesPins, SurfacesState};
use eos_core::inbox::ActionGate;
use eos_core::store::{Store, UserSettingsStore};
use eos_core::surface::{DirectActions, SurfaceTools};
use eos_core::{Clock, Ids};
use eos_runtime::actions::{ActionDecl, Actions};
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::module::{Module, ProtectedSettings};
use eos_runtime::router::RouteDef;

pub use authoring::SurfaceAuthor;
use dispatch::{DispatchParts, Dispatcher};
pub use raw::ProbeDocs;

pub const SURFACES_CHANGE: Topic<SurfacesChange> = Topic::new("surfaces:change");
pub const SURFACES_ISSUE: Topic<SurfacesIssue> = Topic::new("surfaces:issue");
pub const SURFACES_STATE: Topic<SurfacesState> = Topic::new("surfaces:state");
pub const SURFACES_PINS: Topic<SurfacesPins> = Topic::new("surfaces:pins");
pub const ACTIONS_RECORD: Topic<ActionsRecord> = Topic::new("actions:record");

/// What the module is built from.
pub struct SurfacesParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn Ids>,
    /// `settings.json`, for the reading settings.
    pub settings: Arc<dyn UserSettingsStore>,
    /// The kernel's registry of direct actions.
    pub actions: Actions,
    /// Needs you's gate every press passes.
    pub gate: Arc<dyn ActionGate>,
    /// Needs you's items for returned Views.
    pub cards: Arc<dyn eos_core::surface::ViewCards>,
    /// The images of page issues, under `surfaces/<id>/img/`.
    pub images: Arc<dyn eos_core::surface::SurfaceImages>,
    /// The reader's zone: `issue.date` and times read in it.
    pub zone: Arc<dyn eos_core::os::TimeZone>,
    /// The reader's profile, for `issue.reader`.
    pub profile: Arc<dyn eos_core::store::UserProfileStore>,
    /// Memory, told what the reader edits and opens.
    pub feedback: Arc<dyn eos_core::experience::ExperienceFeedback>,
    /// Routines, which run a surface's design and ask runs.
    pub runs: Arc<dyn eos_core::routine::RunStarter>,
}

impl std::fmt::Debug for SurfacesParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SurfacesParts").finish_non_exhaustive()
    }
}

pub struct SurfacesModule {
    parts: Arc<SurfacesParts>,
    dispatcher: Arc<Dispatcher>,
    probe_docs: Arc<ProbeDocs>,
    fills: Arc<fill::Fills>,
    last_good: Arc<queries::LastGood>,
}

impl std::fmt::Debug for SurfacesModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SurfacesModule").finish_non_exhaustive()
    }
}

impl SurfacesModule {
    pub fn new(parts: SurfacesParts) -> Self {
        let dispatcher = Arc::new(Dispatcher::new(DispatchParts {
            store: parts.store.clone(),
            clock: parts.clock.clone(),
            ids: parts.ids.clone(),
            actions: parts.actions.clone(),
            gate: parts.gate.clone(),
            cards: parts.cards.clone(),
        }));
        let probe_docs = Arc::new(ProbeDocs::new(parts.clock.clone(), parts.ids.clone()));
        SurfacesModule {
            parts: Arc::new(parts),
            dispatcher,
            probe_docs,
            fills: Arc::default(),
            last_good: Arc::default(),
        }
    }

    /// The raw-content origin's routes: pages, their images, probe documents.
    pub fn raw_routes(&self) -> Vec<RouteDef> {
        raw::routes(&self.parts, &self.probe_docs)
    }

    /// Page issues drawn for the mail channel.
    pub fn render(&self) -> Arc<dyn eos_core::surface::SurfaceRender> {
        Arc::new(export::MailRender(self.parts.clone()))
    }

    /// Where the page probe's documents are held.
    pub fn probe_docs(&self) -> Arc<ProbeDocs> {
        self.probe_docs.clone()
    }

    /// What a run's sessions call `return_view` through.
    pub fn tools(&self) -> Arc<dyn SurfaceTools> {
        Arc::new(issues::ViewIssues {
            parts: self.parts.clone(),
            fills: self.fills.clone(),
            store: self.parts.store.clone(),
            clock: self.parts.clock.clone(),
            ids: self.parts.ids.clone(),
            actions: self.parts.actions.clone(),
            cards: self.parts.cards.clone(),
        })
    }

    /// The dispatcher, for the features that press a button on the user's
    /// behalf (a Needs-you card, the phone).
    pub fn direct(&self) -> Arc<dyn DirectActions> {
        self.dispatcher.clone()
    }
}

impl Module for SurfacesModule {
    fn id(&self) -> &'static str {
        "surfaces"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut out = pins::routes(&self.parts);
        out.extend(tiles::routes(&self.parts));
        out.extend(routes::all(&self.parts));
        out.extend(issue_routes::all(&self.parts));
        out.extend(edits::routes(&self.parts));
        out.extend(export::routes(&self.parts));
        out.extend(settings::all(&self.parts));
        out.extend(queries::routes(&self.parts, &self.last_good));
        out.extend(action_routes::all(&self.parts, &self.parts.actions, &self.dispatcher));
        out
    }

    fn direct_actions(&self) -> Vec<ActionDecl> {
        builtins::declared(&self.parts.store, &self.parts.runs)
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![
            SURFACES_CHANGE.decl(),
            SURFACES_ISSUE.decl(),
            SURFACES_STATE.decl(),
            SURFACES_PINS.decl(),
            ACTIONS_RECORD.decl(),
        ]
    }

    fn protected_settings(&self) -> Option<ProtectedSettings> {
        Some(ProtectedSettings { keys: settings::KEYS.to_vec(), via: "PUT /api/settings/surfaces" })
    }
}
