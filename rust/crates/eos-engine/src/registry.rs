//! The live sessions, by worker.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use eos_core::accounts::SessionCredential;

use crate::session::EngineSession;

#[derive(Default)]
pub(crate) struct Registry(Mutex<HashMap<String, Arc<EngineSession>>>);

impl Registry {
    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<EngineSession>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn get(&self, worker_id: &str) -> Option<Arc<EngineSession>> {
        self.sessions().get(worker_id).cloned()
    }

    /// Registers a session; `false` when the worker already has one.
    pub(crate) fn insert(&self, session: Arc<EngineSession>) -> bool {
        let mut sessions = self.sessions();
        if sessions.contains_key(session.id()) {
            return false;
        }
        sessions.insert(session.id().to_owned(), session);
        true
    }

    /// Forgets `session` (and only it: a newer session of the worker stays).
    pub(crate) fn remove(&self, session: &EngineSession) {
        let mut sessions = self.sessions();
        if sessions.get(session.id()).is_some_and(|s| std::ptr::eq(Arc::as_ptr(s), session)) {
            sessions.remove(session.id());
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.sessions().len()
    }

    pub(crate) fn is_live(&self, worker_id: &str) -> bool {
        self.sessions().contains_key(worker_id)
    }

    pub(crate) fn is_focused(&self, worker_id: &str) -> bool {
        self.sessions().get(worker_id).is_some_and(|s| s.focused)
    }

    pub(crate) fn set_credential(&self, worker_id: &str, credential: Option<SessionCredential>) {
        if let Some(session) = self.get(worker_id) {
            session.set_credential(credential);
        }
    }

    pub(crate) fn silence_next_failure(&self, worker_id: &str) {
        if let Some(session) = self.get(worker_id) {
            session.silence_next_failure();
        }
    }
}
