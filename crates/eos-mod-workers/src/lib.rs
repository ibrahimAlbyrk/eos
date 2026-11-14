//! Chats and workers, read side.
//!
//! Lists and single rows, transcript pages, the lists that cover a whole
//! conversation (as rows, and its subagents and artifacts as summaries), and
//! the messages waiting for a busy worker; a conversation exported as a page;
//! a worker's project memory. Every route here only reads (the summaries
//! bring their facts up to the log first), but forgetting a project memory; starting, messaging, renaming and removing workers are
//! `eos-mod-agents`.

mod events;
mod export;
mod lists;
mod memory;
mod rows;
mod stream;

use std::sync::Arc;

use eos_core::Clock;
use eos_core::agent::{ModelCatalog, OpenQuestions};
use eos_core::store::{ProjectMemoryStore, Store};
use eos_runtime::module::Module;
use eos_runtime::router::RouteDef;

pub struct WorkersModule {
    store: Arc<dyn Store>,
    models: Arc<dyn ModelCatalog>,
    /// Dates an export.
    clock: Arc<dyn Clock>,
    questions: Option<Arc<dyn OpenQuestions>>,
    memory: Option<Arc<dyn ProjectMemoryStore>>,
}

impl std::fmt::Debug for WorkersModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkersModule").finish_non_exhaustive()
    }
}

impl WorkersModule {
    pub fn new(store: Arc<dyn Store>, models: Arc<dyn ModelCatalog>, clock: Arc<dyn Clock>) -> Self {
        Self { store, models, clock, questions: None, memory: None }
    }

    /// Flags, in the list of workers, the ones waiting on the user's answer.
    pub fn with_open_questions(mut self, questions: Arc<dyn OpenQuestions>) -> Self {
        self.questions = Some(questions);
        self
    }

    /// Serves `/workers/{id}/memory`: Claude Code's memory of the worker's project.
    pub fn with_project_memory(mut self, memory: Arc<dyn ProjectMemoryStore>) -> Self {
        self.memory = Some(memory);
        self
    }
}

impl Module for WorkersModule {
    fn id(&self) -> &'static str {
        "workers"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut routes = rows::routes(self.store.clone(), self.models.clone(), self.questions.clone());
        routes.extend(events::routes(self.store.clone()));
        routes.extend(lists::routes(self.store.clone()));
        routes.push(export::route(self.store.clone(), self.clock.clone()));
        if let Some(memory) = &self.memory {
            routes.extend(memory::routes(self.store.clone(), memory.clone()));
        }
        routes
    }
}
