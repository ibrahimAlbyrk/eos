//! What the pages feature offers the rest of the app: the agent tools' view
//! of pages, and the write path sync applies another computer's pages through.

use std::sync::Arc;

use eos_contracts::{Num, Page, PageAuthor, PageEditRequest, PageSummary};

use crate::{BoxFuture, Error};

/// Pages as an agent reads and edits them (`list_pages`, `read_page`,
/// `create_page`, `append_to_page`, `edit_page`, `set_page_task`). Every call
/// answers what the page routes answer the same agent: the same defaults,
/// the same checks, the same errors.
pub trait PageEditor: Send + Sync + 'static {
    /// The pages of the agent's project, newest first; `all`: of every
    /// project. `query` keeps pages whose title or text contains it.
    fn list<'a>(
        &'a self,
        agent_id: &'a str,
        query: Option<&'a str>,
        all: bool,
    ) -> BoxFuture<'a, Result<Vec<PageSummary>, Error>>;

    fn read<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Arc<Page>, Error>>;

    /// A new page in the agent's project, linked to its chat.
    fn create<'a>(
        &'a self,
        agent_id: &'a str,
        title: &'a str,
        body: &'a str,
    ) -> BoxFuture<'a, Result<Arc<Page>, Error>>;

    /// One targeted edit (append, replace, tick a task) on the page's latest body.
    fn edit<'a>(
        &'a self,
        agent_id: &'a str,
        id: &'a str,
        edit: &'a PageEditRequest,
    ) -> BoxFuture<'a, Result<Arc<Page>, Error>>;
}

/// A page as another computer has it: everything but this computer's own
/// revision and chat link (chats do not travel).
#[derive(Debug, Clone, PartialEq)]
pub struct SyncedPage {
    pub id: String,
    pub title: String,
    pub body: String,
    pub project: Option<String>,
    pub created_at: Num,
    pub updated_at: Num,
    pub updated_by: PageAuthor,
}

/// The pages as the sync feature reads and writes them. Changes applied here
/// are announced like local ones, so open views refresh.
pub trait PageSync: Send + Sync + 'static {
    fn list(&self) -> Vec<Arc<Page>>;
    fn get(&self, id: &str) -> Option<Arc<Page>>;
    /// Stores the page as given; the chat link stays this computer's and the
    /// revision counts on from its own.
    fn apply_synced(&self, page: SyncedPage) -> Result<Arc<Page>, Error>;
    /// Removes the page if it is here.
    fn remove_synced(&self, id: &str) -> Result<(), Error>;
}
