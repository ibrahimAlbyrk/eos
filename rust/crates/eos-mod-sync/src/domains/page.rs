//! Pages: everything but this computer's revision and chat link (chats do
//! not travel). A page's project travels as its repository key, so it lands
//! in the same project on the other computer.

use std::sync::Arc;

use eos_contracts::{Page, SyncDomainName};
use eos_core::git::ProjectKeys;
use eos_core::net::sync::SyncDomain;
use eos_core::pages::{PageSync, SyncedPage};
use eos_core::{BoxFuture, Error};
use eos_domain::sync::SyncItem;
use serde_json::{Value, json};

use super::project_ref::{to_path, to_ref};
use super::refused;

pub struct PageDomain {
    pages: Arc<dyn PageSync>,
    keys: Arc<dyn ProjectKeys>,
}

impl std::fmt::Debug for PageDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PageDomain").finish_non_exhaustive()
    }
}

impl PageDomain {
    pub fn new(pages: Arc<dyn PageSync>, keys: Arc<dyn ProjectKeys>) -> Self {
        Self { pages, keys }
    }

    async fn item(&self, page: &Page) -> Result<SyncItem, Error> {
        let mut data = serde_json::to_value(page).map_err(Error::storage)?;
        let Some(fields) = data.as_object_mut() else { return Err(Error::Storage("a page is an object".into())) };
        for local in ["id", "rev", "agentId", "project"] {
            fields.shift_remove(local);
        }
        let project = match &page.project {
            Some(path) => to_ref(self.keys.as_ref(), path).await,
            None => Value::Null,
        };
        fields.insert("project".to_owned(), project);
        Ok(SyncItem { id: page.id.0.clone(), data, updated_at: Some(page.updated_at.as_f64()) })
    }

    async fn apply_now(&self, id: &str, data: &Value) -> Result<(), Error> {
        let mut page = data.as_object().cloned().ok_or_else(|| refused("a page is an object"))?;
        let project = match page.get("project") {
            Some(Value::Null) => Value::Null,
            Some(project) => Value::String(to_path(self.keys.as_ref(), project).await?),
            None => return Err(refused("project: Required")),
        };
        page.insert("project".to_owned(), project);
        page.insert("id".to_owned(), Value::String(id.to_owned()));
        // The revision and the chat link are this computer's own.
        page.insert("rev".to_owned(), json!(0));
        page.insert("agentId".to_owned(), Value::Null);
        let page: Page = eos_contracts::validate::parse(&Value::Object(page)).map_err(refused)?;
        let synced = SyncedPage {
            id: page.id.0,
            title: page.title,
            body: page.body,
            project: page.project,
            created_at: page.created_at,
            updated_at: page.updated_at,
            updated_by: page.updated_by,
        };
        self.pages.apply_synced(synced).map(|_| ())
    }
}

impl SyncDomain for PageDomain {
    fn name(&self) -> SyncDomainName {
        SyncDomainName::Page
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<SyncItem>, Error>> {
        Box::pin(async move {
            let pages = self.pages.list();
            let mut items = Vec::with_capacity(pages.len());
            for page in &pages {
                items.push(self.item(page).await?);
            }
            Ok(items)
        })
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<SyncItem>, Error>> {
        Box::pin(async move {
            match self.pages.get(id) {
                Some(page) => Ok(Some(self.item(&page).await?)),
                None => Ok(None),
            }
        })
    }

    fn apply<'a>(&'a self, id: &'a str, data: &'a Value) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(self.apply_now(id, data))
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), Error>> {
        Box::pin(std::future::ready(self.pages.remove_synced(id)))
    }
}
