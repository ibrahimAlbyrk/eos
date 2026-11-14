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

impl PageDesk {
    pub fn new(pages: Arc<PageService>, store: Arc<dyn Store>) -> Self {
        Self { pages, store }
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
    pub fn create(&self, caller: &PageCaller, request: PageCreateRequest) -> Result<Arc<Page>, Error> {
        let request = checked(request)?;
        let new = NewPage {
            title: request.title,
            body: request.body,
            project: request.project.unwrap_or_else(|| caller.project.clone()),
            agent_id: request.agent_id.unwrap_or_else(|| caller.session.clone()),
        };
        self.pages.create(new, caller.author.clone())
    }

    pub fn save(&self, caller: &PageCaller, id: &str, request: PageUpdateRequest) -> Result<Arc<Page>, Error> {
        let id = page_id(id)?;
        let request = checked(request)?;
        let save = PageSave { title: request.title, body: request.body, base_rev: request.base_rev };
        self.pages.save(id, save, caller.author.clone())
    }

    pub fn edit(&self, caller: &PageCaller, id: &str, edit: &PageEditRequest) -> Result<Arc<Page>, Error> {
        let id = page_id(id)?;
        eos_contracts::check(edit).map_err(|e| eos_core::Error::Validation(e.message()))?;
        self.pages.edit(id, edit, caller.author.clone())
    }

    /// Deleting is the user's.
    pub fn remove(&self, id: &str) -> Result<(), Error> {
        self.pages.remove(page_id(id)?, PageCaller::user().author)
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
            let caller = self.caller(Some(agent_id)).await?;
            let request =
                PageCreateRequest { title: title.to_owned(), body: body.to_owned(), project: None, agent_id: None };
            Ok(PageDesk::create(self, &caller, request)?)
        })
    }

    fn edit<'a>(
        &'a self,
        agent_id: &'a str,
        id: &'a str,
        edit: &'a PageEditRequest,
    ) -> BoxFuture<'a, Result<Arc<Page>, eos_core::Error>> {
        Box::pin(async move {
            let caller = self.caller(Some(agent_id)).await?;
            Ok(PageDesk::edit(self, &caller, id, edit)?)
        })
    }
}
