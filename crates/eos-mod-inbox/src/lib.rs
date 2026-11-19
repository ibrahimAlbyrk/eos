//! Needs you: what waits for the user, over the items of `eos_inbox`.
//!
//! - `GET /api/inbox?state=&routineId=&cursor=`: one page of 100 items in
//!   Needs you's order (open before later, the loudest first, then the
//!   newest), the counts of everything that waits, and `agentsWaiting`: the
//!   open asks and questions of Agents chats, shown as one line, not items;
//! - `GET /api/inbox/:id`: one item with what its kind carries;
//! - `PUT /api/inbox/:id/draft {rev, doc}`: the user's edits of a draft;
//! - `POST /api/inbox/:id/later {until?}` and `…/discard {rev}`;
//! - `POST /api/inbox/:id/answer {rev, answer}`: an answer of the item's kind.
//!
//! A routine run's permission asks (`perm:<pending id>`) and the memory
//! suggestions about the user (`sugg:<memory id>`) are listed among the items
//! without being copied into them; each is answered through its own recorded
//! route, which a write here names in its 409.
//!
//! Every route answers the user's text, so only the user's dashboard and
//! phone reach them. Writes are announced on `inbox:change`.

mod project;
mod routes;

use std::sync::Arc;

use eos_contracts::InboxChange;
use eos_core::Clock;
use eos_core::agent::OpenQuestions;
use eos_core::profile::UserMemoryReader;
use eos_core::store::Store;
use eos_inbox::Items;
use eos_runtime::bus::{Topic, TopicDecl};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;

pub const INBOX_CHANGE: Topic<InboxChange> = Topic::new(eos_inbox::INBOX_CHANGE);

/// What the module is built from.
pub struct InboxParts {
    pub store: Arc<dyn Store>,
    pub clock: Arc<dyn Clock>,
    /// The questions agents wait on.
    pub questions: Arc<dyn OpenQuestions>,
    /// The memories, the suggestions about the user among them.
    pub memories: Arc<dyn UserMemoryReader>,
}

impl std::fmt::Debug for InboxParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InboxParts").finish_non_exhaustive()
    }
}

pub struct InboxModule {
    parts: Arc<Shared>,
}

/// What every route holds.
pub(crate) struct Shared {
    pub(crate) store: Arc<dyn Store>,
    pub(crate) items: Items,
    pub(crate) questions: Arc<dyn OpenQuestions>,
    pub(crate) memories: Arc<dyn UserMemoryReader>,
}

impl std::fmt::Debug for InboxModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InboxModule").finish_non_exhaustive()
    }
}

impl InboxModule {
    pub fn new(parts: InboxParts) -> Self {
        let InboxParts { store, clock, questions, memories } = parts;
        let items = Items::new(store.clone(), clock);
        Self { parts: Arc::new(Shared { store, items, questions, memories }) }
    }
}

impl Module for InboxModule {
    fn id(&self) -> &'static str {
        "inbox"
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![INBOX_CHANGE.decl()]
    }

    fn routes(&self) -> Vec<RouteDef> {
        routes::all(&self.parts)
    }
}
