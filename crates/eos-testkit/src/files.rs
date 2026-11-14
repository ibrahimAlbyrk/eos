//! Fakes of the file-store ports: the same behaviour, nothing on disk.

use std::sync::{Arc, Mutex};

use eos_contracts::{Page, UserMemory, UserProfile};
use eos_core::Error;
use eos_core::prompt::{MemoryDoc, MemoryProvider, MemoryScope, MemorySnapshot};
use eos_core::store::{PageStore, UserAvatar, UserAvatarStore, UserMemoryStore, UserProfileStore};
use indexmap::IndexMap;

/// Documents by id, in insertion order, as the file stores keep them.
#[derive(Debug)]
struct Docs<T>(Mutex<IndexMap<String, Arc<T>>>);

impl<T> Default for Docs<T> {
    fn default() -> Self {
        Self(Mutex::default())
    }
}

impl<T: eos_contracts::Validate> Docs<T> {
    fn list(&self) -> Vec<Arc<T>> {
        self.0.lock().expect("docs").values().cloned().collect()
    }

    fn get(&self, id: &str) -> Option<Arc<T>> {
        self.0.lock().expect("docs").get(id).cloned()
    }

    fn put(&self, id: String, doc: T) -> Result<Arc<T>, Error> {
        eos_contracts::check(&doc).map_err(|e| Error::Validation(e.message()))?;
        let doc = Arc::new(doc);
        self.0.lock().expect("docs").insert(id, doc.clone());
        Ok(doc)
    }

    fn remove(&self, id: &str) -> bool {
        self.0.lock().expect("docs").shift_remove(id).is_some()
    }
}

#[derive(Debug, Default)]
pub struct FakePageStore(Docs<Page>);

impl PageStore for FakePageStore {
    fn list(&self) -> Vec<Arc<Page>> {
        self.0.list()
    }
    fn get(&self, id: &str) -> Option<Arc<Page>> {
        self.0.get(id)
    }
    fn put(&self, page: Page) -> Result<Arc<Page>, Error> {
        self.0.put(page.id.0.clone(), page)
    }
    fn remove(&self, id: &str) -> Result<bool, Error> {
        Ok(self.0.remove(id))
    }
}

#[derive(Debug, Default)]
pub struct FakeUserMemoryStore(Docs<UserMemory>);

impl UserMemoryStore for FakeUserMemoryStore {
    fn list(&self) -> Vec<Arc<UserMemory>> {
        self.0.list()
    }
    fn get(&self, id: &str) -> Option<Arc<UserMemory>> {
        self.0.get(id)
    }
    fn put(&self, memory: UserMemory) -> Result<Arc<UserMemory>, Error> {
        self.0.put(memory.id.0.clone(), memory)
    }
    fn remove(&self, id: &str) -> Result<bool, Error> {
        Ok(self.0.remove(id))
    }
}

#[derive(Debug, Default)]
pub struct FakeUserProfileStore(Mutex<Option<Arc<UserProfile>>>);

impl UserProfileStore for FakeUserProfileStore {
    fn get(&self) -> Option<Arc<UserProfile>> {
        self.0.lock().expect("profile").clone()
    }
    fn put(&self, profile: UserProfile) -> Result<Arc<UserProfile>, Error> {
        eos_contracts::check(&profile).map_err(|e| Error::Validation(e.message()))?;
        let profile = Arc::new(profile);
        *self.0.lock().expect("profile") = Some(profile.clone());
        Ok(profile)
    }
}

#[derive(Debug, Default)]
pub struct FakeUserAvatarStore(Mutex<Option<UserAvatar>>);

impl UserAvatarStore for FakeUserAvatarStore {
    fn read(&self) -> Result<Option<UserAvatar>, Error> {
        Ok(self.0.lock().expect("avatar").clone())
    }
    fn write(&self, avatar: &UserAvatar) -> Result<(), Error> {
        *self.0.lock().expect("avatar") = Some(avatar.clone());
        Ok(())
    }
    fn remove(&self) -> Result<(), Error> {
        *self.0.lock().expect("avatar") = None;
        Ok(())
    }
}

/// Answers every scope with the same memory files.
#[derive(Debug, Default)]
pub struct FakeMemoryProvider {
    pub docs: Vec<MemoryDoc>,
}

impl MemoryProvider for FakeMemoryProvider {
    fn load(&self, _scope: MemoryScope<'_>) -> MemorySnapshot {
        MemorySnapshot { docs: self.docs.clone() }
    }
}
