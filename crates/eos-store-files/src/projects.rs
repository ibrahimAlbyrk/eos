//! `projects.json`.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{Project, ProjectUpsertRequest};
use eos_core::store::ProjectStore;
use eos_core::{Error, Ids};
use serde_json::Value;

use crate::json;

/// The user's projects: a JSON array in creation order, pretty-printed.
pub struct JsonProjects {
    file: PathBuf,
    ids: Arc<dyn Ids>,
    projects: Mutex<Vec<Project>>,
}

impl std::fmt::Debug for JsonProjects {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonProjects").field("file", &self.file).finish_non_exhaustive()
    }
}

impl JsonProjects {
    /// Entries that are not valid projects are left out rather than failing
    /// the whole file.
    pub fn open(file: impl Into<PathBuf>, ids: Arc<dyn Ids>) -> Self {
        let file = file.into();
        let projects = match json::read(&file) {
            Some(Value::Array(entries)) => entries.iter().filter_map(|e| eos_contracts::parse(e).ok()).collect(),
            _ => Vec::new(),
        };
        Self { file, ids, projects: Mutex::new(projects) }
    }

    fn projects(&self) -> MutexGuard<'_, Vec<Project>> {
        self.projects.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, projects: &[Project]) -> Result<(), Error> {
        json::write(&self.file, &serde_json::to_string_pretty(projects).map_err(Error::storage)?)
    }
}

impl ProjectStore for JsonProjects {
    fn list(&self) -> Vec<Project> {
        self.projects().clone()
    }

    fn upsert(&self, input: ProjectUpsertRequest) -> Result<Project, Error> {
        let mut folders: Vec<String> = Vec::with_capacity(input.folders.len());
        for folder in input.folders {
            if !folders.contains(&folder) {
                folders.push(folder);
            }
        }
        let project = Project {
            id: input.id.unwrap_or_else(|| self.ids.uuid()),
            name: input.name,
            icon: input.icon,
            folders,
            pinned: input.pinned,
        };
        let mut projects = self.projects();
        let mut next = projects.clone();
        match next.iter_mut().find(|p| p.id == project.id) {
            Some(existing) => *existing = project.clone(),
            None => next.push(project.clone()),
        }
        self.save(&next)?;
        *projects = next;
        Ok(project)
    }

    fn remove(&self, id: &str) -> Result<Option<Project>, Error> {
        let mut projects = self.projects();
        let Some(index) = projects.iter().position(|p| p.id == id) else { return Ok(None) };
        let mut next = projects.clone();
        let removed = next.remove(index);
        self.save(&next)?;
        *projects = next;
        Ok(Some(removed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_testkit::{SeqIds, TempHome};

    fn request(id: Option<&str>, name: &str, folders: &[&str]) -> ProjectUpsertRequest {
        ProjectUpsertRequest {
            id: id.map(str::to_owned),
            name: name.into(),
            icon: None,
            folders: folders.iter().map(|f| (*f).to_owned()).collect(),
            pinned: None,
        }
    }

    #[test]
    fn projects_are_created_replaced_removed_and_survive_a_reopen() {
        let home = TempHome::new();
        let open = || JsonProjects::open(home.join("projects.json"), Arc::new(SeqIds::new()));
        let store = open();
        assert!(store.list().is_empty());

        let alpha = store.upsert(request(None, "Alpha", &["/a", "/a", "/b"])).expect("creates");
        assert_eq!(alpha.id, "00000000-0000-4000-8000-000000000001");
        assert_eq!(alpha.folders, ["/a", "/b"], "folders are deduplicated");
        let beta = store.upsert(request(None, "Beta", &["/c"])).expect("creates");
        store.upsert(request(Some(&alpha.id), "Alpha 2", &["/a"])).expect("replaces");
        assert_eq!(store.list().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Alpha 2", "Beta"]);

        // Pretty-printed with two spaces, as JSON.stringify(…, null, 2) writes it.
        assert!(home.read("projects.json").starts_with("[\n  {\n    \"id\": \"00000000-"));
        assert_eq!(open().list(), store.list());

        assert_eq!(store.remove(&beta.id).expect("removes").map(|p| p.name), Some("Beta".into()));
        assert_eq!(store.remove(&beta.id).expect("no-op"), None);
        assert_eq!(open().list().len(), 1);
    }

    #[test]
    fn a_broken_file_or_entry_does_not_stop_the_store() {
        let home = TempHome::new();
        home.write(
            "projects.json",
            r#"[{"id":"p1","name":"Ok","folders":["/a"]},{"id":"p2","name":"","folders":[]},7]"#,
        );
        let store = JsonProjects::open(home.join("projects.json"), Arc::new(SeqIds::new()));
        assert_eq!(store.list().iter().map(|p| p.id.as_str()).collect::<Vec<_>>(), ["p1"]);

        home.write("projects.json", "{nope");
        assert!(JsonProjects::open(home.join("projects.json"), Arc::new(SeqIds::new())).list().is_empty());
    }
}
