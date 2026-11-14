//! The one write path for pages, shared by the routes, the agent tools and
//! sync. Every write bumps `rev` and announces `pages:change`, so an open
//! editor refetches. A full-body save carrying a stale revision is refused with
//! the current page instead of overwriting an edit the caller has not seen;
//! targeted edits apply to the latest body.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::{
    Num, Page, PageAuthor, PageChangeEvent, PageChangeEventAction, PageEditRequest, PageId, PageSummary,
};
use eos_core::pages::{PageSync, SyncedPage};
use eos_core::store::PageStore;
use eos_core::{Clock, Ids};
use eos_domain::page::{EXCERPT_MAX, apply_page_edit, page_excerpt, page_task_counts};
use eos_domain::text::js_trim;
use eos_runtime::bus::Bus;

use crate::{Error, PAGES_CHANGE};

/// What a new page starts with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPage {
    pub title: String,
    pub body: String,
    pub project: Option<String>,
    pub agent_id: Option<String>,
}

/// A full save: what is absent stays as it is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageSave {
    pub title: Option<String>,
    pub body: Option<String>,
    /// The revision the caller edited; a different current one refuses the save.
    pub base_rev: Option<i64>,
}

/// The row of a page in a list: everything but the body, plus its excerpt and
/// checklist counts.
pub fn summarize_page(page: &Page) -> PageSummary {
    PageSummary {
        id: page.id.clone(),
        title: page.title.clone(),
        project: page.project.clone(),
        agent_id: page.agent_id.clone(),
        rev: page.rev,
        created_at: page.created_at,
        updated_at: page.updated_at,
        updated_by: page.updated_by.clone(),
        excerpt: page_excerpt(&page.body, EXCERPT_MAX),
        tasks: page_task_counts(&page.body),
    }
}

pub struct PageService {
    store: Arc<dyn PageStore>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    bus: Bus,
    /// One change at a time: reading the current page, deciding, writing and
    /// announcing are one step, so two saves cannot both pass the revision
    /// check and events leave in the order of the writes.
    changing: Mutex<()>,
}

impl std::fmt::Debug for PageService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PageService").finish_non_exhaustive()
    }
}

impl PageService {
    pub fn new(store: Arc<dyn PageStore>, clock: Arc<dyn Clock>, ids: Arc<dyn Ids>, bus: Bus) -> Self {
        Self { store, clock, ids, bus, changing: Mutex::new(()) }
    }

    fn change(&self) -> MutexGuard<'_, ()> {
        self.changing.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn now(&self) -> Num {
        Num::from(self.clock.now_ms())
    }

    /// Pages newest first. `project`: only that project's; `query`: only
    /// those whose title or body contains it, whatever the case.
    pub fn list(&self, project: Option<&str>, query: Option<&str>) -> Vec<PageSummary> {
        let query = query.map(|q| js_trim(q).to_lowercase()).filter(|q| !q.is_empty());
        let mut pages: Vec<Arc<Page>> = self
            .store
            .list()
            .into_iter()
            .filter(|p| project.is_none_or(|project| p.project.as_deref() == Some(project)))
            .filter(|p| {
                query.as_ref().is_none_or(|q| p.title.to_lowercase().contains(q) || p.body.to_lowercase().contains(q))
            })
            .collect();
        pages.sort_by(|a, b| b.updated_at.0.partial_cmp(&a.updated_at.0).unwrap_or(std::cmp::Ordering::Equal));
        pages.iter().map(|page| summarize_page(page)).collect()
    }

    pub fn get(&self, id: &str) -> Result<Arc<Page>, Error> {
        self.store.get(id).ok_or_else(|| eos_core::Error::not_found("page", id).into())
    }

    pub fn create(&self, new: NewPage, by: PageAuthor) -> Result<Arc<Page>, Error> {
        let _changing = self.change();
        let now = self.now();
        let page = self.store.put(Page {
            id: PageId(self.ids.page_id()),
            title: js_trim(&new.title).to_owned(),
            body: new.body,
            project: new.project,
            agent_id: new.agent_id,
            rev: 1,
            created_at: now,
            updated_at: now,
            updated_by: by.clone(),
        })?;
        self.announce(&page, PageChangeEventAction::Created, by);
        Ok(page)
    }

    pub fn save(&self, id: &str, save: PageSave, by: PageAuthor) -> Result<Arc<Page>, Error> {
        let _changing = self.change();
        let cur = self.get(id)?;
        if save.base_rev.is_some_and(|rev| rev != cur.rev) {
            return Err(Error::Stale(cur));
        }
        let title = save.title.map_or_else(|| cur.title.clone(), |title| js_trim(&title).to_owned());
        let body = save.body.unwrap_or_else(|| cur.body.clone());
        self.write(cur, title, body, by)
    }

    /// One targeted edit on the latest body.
    pub fn edit(&self, id: &str, edit: &PageEditRequest, by: PageAuthor) -> Result<Arc<Page>, Error> {
        let _changing = self.change();
        let cur = self.get(id)?;
        let body = apply_page_edit(&cur.body, edit).map_err(|why| eos_core::Error::Validation(why.to_string()))?;
        let title = cur.title.clone();
        self.write(cur, title, body, by)
    }

    pub fn remove(&self, id: &str, by: PageAuthor) -> Result<(), Error> {
        let _changing = self.change();
        let cur = self.get(id)?;
        self.store.remove(id)?;
        self.announce(&cur, PageChangeEventAction::Deleted, by);
        Ok(())
    }

    /// The chat a page was linked to is gone: the page stays, unlinked.
    pub fn unlink_agent(&self, agent_id: &str) -> Result<(), Error> {
        let _changing = self.change();
        for page in self.store.list().iter().filter(|p| p.agent_id.as_deref() == Some(agent_id)) {
            let unlinked = self.store.put(Page { agent_id: None, rev: page.rev + 1, ..Page::clone(page) })?;
            self.announce(&unlinked, PageChangeEventAction::Updated, page.updated_by.clone());
        }
        Ok(())
    }

    /// True when a page is linked to that chat.
    pub fn links_agent(&self, agent_id: &str) -> bool {
        self.store.list().iter().any(|p| p.agent_id.as_deref() == Some(agent_id))
    }

    fn write(&self, cur: Arc<Page>, title: String, body: String, by: PageAuthor) -> Result<Arc<Page>, Error> {
        if title == cur.title && body == cur.body {
            return Ok(cur);
        }
        let page = self.store.put(Page {
            title,
            body,
            rev: cur.rev + 1,
            updated_at: self.now(),
            updated_by: by.clone(),
            ..Page::clone(&cur)
        })?;
        self.announce(&page, PageChangeEventAction::Updated, by);
        Ok(page)
    }

    /// Called with the change lock held, after the write returned.
    fn announce(&self, page: &Page, action: PageChangeEventAction, by: PageAuthor) {
        let event = PageChangeEvent { id: page.id.clone(), action, rev: page.rev, project: page.project.clone(), by };
        self.bus.publish(&PAGES_CHANGE, &event);
    }
}

impl PageSync for PageService {
    fn list(&self) -> Vec<Arc<Page>> {
        self.store.list()
    }

    fn get(&self, id: &str) -> Option<Arc<Page>> {
        self.store.get(id)
    }

    fn apply_synced(&self, page: SyncedPage) -> Result<Arc<Page>, eos_core::Error> {
        let _changing = self.change();
        let cur = self.store.get(&page.id);
        let saved = self.store.put(Page {
            id: PageId(page.id),
            title: page.title,
            body: page.body,
            project: page.project,
            agent_id: cur.as_ref().and_then(|cur| cur.agent_id.clone()),
            rev: cur.as_ref().map_or(0, |cur| cur.rev) + 1,
            created_at: page.created_at,
            updated_at: page.updated_at,
            updated_by: page.updated_by,
        })?;
        let action = if cur.is_some() { PageChangeEventAction::Updated } else { PageChangeEventAction::Created };
        self.announce(&saved, action, saved.updated_by.clone());
        Ok(saved)
    }

    fn remove_synced(&self, id: &str) -> Result<(), eos_core::Error> {
        let _changing = self.change();
        let Some(cur) = self.store.get(id) else { return Ok(()) };
        self.store.remove(id)?;
        self.announce(&cur, PageChangeEventAction::Deleted, cur.updated_by.clone());
        Ok(())
    }
}
