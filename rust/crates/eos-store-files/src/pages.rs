//! Pages as markdown files under `<home>/pages/<id>.md`: YAML frontmatter
//! (everything but the body), then the markdown body, so a page stays readable
//! by hand and survives a wipe of `state.db`. A deleted page goes to `.trash/`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use eos_contracts::Page;
use eos_core::store::PageStore;
use eos_core::{Clock, Error};
use eos_kit_fs::{DocDir, frontmatter};
use serde_json::Value;

pub struct FilePageStore {
    docs: DocDir<Page>,
    clock: Arc<dyn Clock>,
}

impl std::fmt::Debug for FilePageStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FilePageStore").field("dir", &self.docs.dir()).finish_non_exhaustive()
    }
}

impl FilePageStore {
    /// Reads every page of `dir`. A file that does not read as a page is
    /// skipped: one bad page must not hide the rest.
    pub fn open(dir: impl Into<PathBuf>, clock: Arc<dyn Clock>) -> Self {
        let docs = DocDir::load(dir, "md", |raw| parse_page(raw).map(|page| (page.id.0.clone(), page)));
        Self { docs, clock }
    }
}

impl PageStore for FilePageStore {
    fn list(&self) -> Vec<Arc<Page>> {
        self.docs.list()
    }

    fn get(&self, id: &str) -> Option<Arc<Page>> {
        self.docs.get(id)
    }

    fn put(&self, page: Page) -> Result<Arc<Page>, Error> {
        eos_contracts::check(&page).map_err(|e| Error::Validation(e.message()))?;
        let content = serialize_page(&page)?;
        let id = page.id.0.clone();
        self.docs.put(&id, page, &content).map_err(Error::storage)
    }

    fn remove(&self, id: &str) -> Result<bool, Error> {
        let now = UNIX_EPOCH + Duration::from_millis(u64::try_from(self.clock.now_ms()).unwrap_or(0));
        self.docs.remove(id, now).map_err(Error::storage)
    }
}

/// The file of a page: its fields but the body as frontmatter, in the page's
/// field order, then the body verbatim.
pub fn serialize_page(page: &Page) -> Result<String, Error> {
    let mut meta = serde_json::to_value(page).map_err(Error::storage)?;
    if let Value::Object(fields) = &mut meta {
        fields.shift_remove("body");
    }
    frontmatter::join(&meta, &page.body).map_err(Error::storage)
}

/// Reads a page file. `None` when it has no frontmatter or is not a page.
pub fn parse_page(raw: &str) -> Option<Page> {
    let (mut meta, body) = frontmatter::parse::<Value>(raw).ok()??;
    meta.as_object_mut()?.insert("body".to_owned(), Value::String(body.to_owned()));
    eos_contracts::parse(&meta).ok()
}
