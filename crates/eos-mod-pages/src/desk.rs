//! Pages as one caller sees them: the user's window, or an agent whose chat
//! and project are the defaults for what it lists and creates. The routes
//! and the agent tools both go through here, so they answer alike.

use std::sync::Arc;

use eos_contracts::{
    Page, PageAuthor, PageAuthorKind, PageCreateRequest, PageEditRequest, PageId, PageSummary, PageUpdateRequest,
};
use eos_core::BoxFuture;
use eos_core::pages::PageEditor;
use eos_core::store::{Store, agent_caller};

use crate::Error;
use crate::service::{NewPage, PageSave, PageService};

/// Who acts on pages, and their defaults.
#[derive(Debug, Clone, PartialEq)]
pub struct PageCaller {
    pub author: PageAuthor,
    /// An agent's own chat: what a page it creates is linked to.
    pub session: Option<String>,
    /// An agent's project: what it lists and where it creates.
    pub project: Option<String>,
}

impl PageCaller {
    /// The user's own window.
    pub fn user() -> Self {
        Self {
            author: PageAuthor { kind: PageAuthorKind::User, agent_id: None, name: None },
            session: None,
            project: None,
        }
    }
}

pub struct PageDesk {
    pub(crate) pages: Arc<PageService>,
    store: Arc<dyn Store>,
    /// Changes go one at a time, in the order they were asked (a FIFO lock).
    turns: Arc<tokio::sync::Mutex<()>>,
}

/// A change's turn ([`PageDesk::turn`]), held until the change is done.
#[derive(Debug)]
pub struct Turn {
    _held: tokio::sync::OwnedMutexGuard<()>,
}

impl std::fmt::Debug for PageDesk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PageDesk").finish_non_exhaustive()
    }
}

fn checked<T: eos_contracts::Validate>(value: T) -> Result<T, Error> {
    eos_contracts::check(&value).map_err(|e| eos_core::Error::Validation(e.message()))?;
    Ok(value)
}

fn page_id(id: &str) -> Result<&str, Error> {
    checked(PageId(id.to_owned()))?;
    Ok(id)
}

/// A change runs on a blocking thread: the page file is flushed to the disk while the
/// service's change lock is held, which must not stall an async worker. It keeps its turn
/// until done, also when the request is dropped meanwhile.
async fn off_thread<T: Send + 'static>(
    turn: Turn,
    change: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    let change = move || {
        let _turn = turn;
        change()
    };
    tokio::task::spawn_blocking(change).await.map_err(eos_core::Error::storage)?
}

impl PageDesk {
    pub fn new(pages: Arc<PageService>, store: Arc<dyn Store>) -> Self {
        Self { pages, store, turns: Arc::default() }
    }

    /// Taken first by every change, before anything else it waits for (who the caller is):
    /// changes apply in the order they came.
    pub async fn turn(&self) -> Turn {
        Turn { _held: self.turns.clone().lock_owned().await }
    }

    /// The caller a request names with `x-eos-agent-id`: that agent when the
    /// id is a known worker, else the user. Declared, not proven: it
    /// attributes edits and scopes defaults.
    pub async fn caller(&self, agent_id: Option<&str>) -> Result<PageCaller, eos_core::Error> {
        let header = agent_id.map(str::to_owned);
        let agent = self.store.read(move |tx| agent_caller(tx.workers(), header.as_deref())).await?;
        Ok(match agent {
            None => PageCaller::user(),
            Some(agent) => PageCaller {
                author: PageAuthor { kind: PageAuthorKind::Agent, agent_id: Some(agent.id), name: agent.name },
                session: Some(agent.session),
                project: agent.project,
            },
        })
    }

    /// `project`: one project's pages; `all`: every page; with neither, the
    /// caller's own project (the user: everything).
    pub fn list(&self, caller: &PageCaller, project: Option<&str>, all: bool, query: Option<&str>) -> Vec<PageSummary> {
        let project = if all { None } else { project.or(caller.project.as_deref()) };
        self.pages.list(project, query)
    }

    pub fn read(&self, id: &str) -> Result<Arc<Page>, Error> {
        self.pages.get(page_id(id)?)
    }

    /// What the request leaves out comes from the caller: its project, its chat.
    pub async fn create(
        &self,
        turn: Turn,
        caller: &PageCaller,
        request: PageCreateRequest,
    ) -> Result<Arc<Page>, Error> {
        let request = checked(request)?;
        let new = NewPage {
            title: request.title,
            body: request.body,
            project: request.project.unwrap_or_else(|| caller.project.clone()),
            agent_id: request.agent_id.unwrap_or_else(|| caller.session.clone()),
        };
        let (pages, by) = (self.pages.clone(), caller.author.clone());
        off_thread(turn, move || pages.create(new, by)).await
    }

    pub async fn save(
        &self,
        turn: Turn,
        caller: &PageCaller,
        id: &str,
        request: PageUpdateRequest,
    ) -> Result<Arc<Page>, Error> {
        let id = page_id(id)?.to_owned();
        let request = checked(request)?;
        let save = PageSave { title: request.title, body: request.body, base_rev: request.base_rev };
        let (pages, by) = (self.pages.clone(), caller.author.clone());
        off_thread(turn, move || pages.save(&id, save, by)).await
    }

    pub async fn edit(
        &self,
        turn: Turn,
        caller: &PageCaller,
        id: &str,
        edit: &PageEditRequest,
    ) -> Result<Arc<Page>, Error> {
        let id = page_id(id)?.to_owned();
        eos_contracts::check(edit).map_err(|e| eos_core::Error::Validation(e.message()))?;
        let (pages, by, edit) = (self.pages.clone(), caller.author.clone(), edit.clone());
        off_thread(turn, move || pages.edit(&id, &edit, by)).await
    }

    /// Deleting is the user's.
    pub async fn remove(&self, id: &str) -> Result<(), Error> {
        let (pages, id) = (self.pages.clone(), page_id(id)?.to_owned());
        let turn = self.turn().await;
        off_thread(turn, move || pages.remove(&id, PageCaller::user().author)).await
    }
}

impl PageEditor for PageDesk {
    fn list<'a>(
        &'a self,
        agent_id: &'a str,
        query: Option<&'a str>,
        all: bool,
    ) -> BoxFuture<'a, Result<Vec<PageSummary>, eos_core::Error>> {
        Box::pin(async move {
            let caller = self.caller(Some(agent_id)).await?;
            Ok(PageDesk::list(self, &caller, None, all, query))
        })
    }

    fn read<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Arc<Page>, eos_core::Error>> {
        Box::pin(async move { Ok(PageDesk::read(self, id)?) })
    }

    fn create<'a>(
        &'a self,
        agent_id: &'a str,
        title: &'a str,
        body: &'a str,
    ) -> BoxFuture<'a, Result<Arc<Page>, eos_core::Error>> {
        Box::pin(async move {
            let turn = self.turn().await;
            let caller = self.caller(Some(agent_id)).await?;
            let request =
                PageCreateRequest { title: title.to_owned(), body: body.to_owned(), project: None, agent_id: None };
            Ok(PageDesk::create(self, turn, &caller, request).await?)
        })
    }

    fn edit<'a>(
        &'a self,
        agent_id: &'a str,
        id: &'a str,
        edit: &'a PageEditRequest,
    ) -> BoxFuture<'a, Result<Arc<Page>, eos_core::Error>> {
        Box::pin(async move {
            let turn = self.turn().await;
            let caller = self.caller(Some(agent_id)).await?;
            Ok(PageDesk::edit(self, turn, &caller, id, edit).await?)
        })
    }
}
