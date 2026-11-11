//! Memory as an agent reaches it: it may only search and suggest. A backend
//! kind the user withholds the profile from is refused both, so the memory
//! never reaches that provider by tool either. The routes and the agent
//! tools both go through here, so they answer alike.

use std::sync::Arc;

use eos_contracts::{
    UserMemory, UserMemoryScope, UserMemoryScopeProject, UserMemorySource, UserMemorySourceAgent,
    UserMemorySuggestRequest, UserMemorySuggestRequestScope,
};
use eos_core::profile::{MemorySearch, MemorySuggestions, UserMemorySuggestResult, UserMemorySuggestion};
use eos_core::store::{AgentCaller, Store, agent_caller};
use eos_core::{BoxFuture, Error};

use crate::memories::UserMemoryService;
use crate::profile::UserProfileService;

/// The most results one search returns.
pub const SEARCH_LIMIT_MAX: usize = 20;
/// How many it returns when the caller names no number.
pub const SEARCH_LIMIT_DEFAULT: usize = 8;

const WITHHELD: &str = "the user doesn't share their profile with this provider";

pub struct AgentMemory {
    pub(crate) memories: Arc<UserMemoryService>,
    pub(crate) profile: Arc<UserProfileService>,
    store: Arc<dyn Store>,
}

impl std::fmt::Debug for AgentMemory {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AgentMemory").finish_non_exhaustive()
    }
}

impl AgentMemory {
    pub fn new(memories: Arc<UserMemoryService>, profile: Arc<UserProfileService>, store: Arc<dyn Store>) -> Self {
        Self { memories, profile, store }
    }

    /// The agent a request names with `x-eos-agent-id`, when the id is a
    /// known worker.
    pub async fn caller(&self, agent_id: Option<&str>) -> Result<Option<AgentCaller>, Error> {
        let header = agent_id.map(str::to_owned);
        self.store.read(move |tx| agent_caller(tx.workers(), header.as_deref())).await
    }

    fn withheld(&self, agent: &AgentCaller) -> bool {
        agent.kind.as_ref().is_some_and(|kind| self.profile.get().sharing.withhold_from.contains(kind))
    }

    /// An agent searches its own session's project; anyone else names one.
    pub fn search(
        &self,
        agent: Option<&AgentCaller>,
        project: Option<&str>,
        query: &str,
        limit: usize,
    ) -> Result<Vec<Arc<UserMemory>>, Error> {
        if agent.is_some_and(|agent| self.withheld(agent)) {
            return Err(Error::PermissionDenied(WITHHELD.into()));
        }
        let project = agent.map_or(project, |agent| agent.project.as_deref());
        Ok(self.memories.search(query, project, limit.clamp(1, SEARCH_LIMIT_MAX)))
    }

    /// Whether `agent` may suggest: only a known agent the profile is shared with.
    pub fn may_suggest(&self, agent: Option<&AgentCaller>) -> Result<(), Error> {
        match agent {
            None => Err(Error::PermissionDenied("only an agent can suggest a memory".into())),
            Some(agent) if self.withheld(agent) => Err(Error::PermissionDenied(WITHHELD.into())),
            Some(_) => Ok(()),
        }
    }

    /// Files an agent's suggestion. "project" means the agent's own session
    /// project: an agent never names a path.
    pub fn suggest(
        &self,
        agent: &AgentCaller,
        request: UserMemorySuggestRequest,
    ) -> Result<UserMemorySuggestResult, Error> {
        eos_contracts::check(&request).map_err(|e| Error::Validation(e.message()))?;
        let scope = match (request.scope, &agent.project) {
            (UserMemorySuggestRequestScope::Global, _) => UserMemoryScope::Global,
            (UserMemorySuggestRequestScope::Project, Some(path)) => {
                UserMemoryScope::Project(UserMemoryScopeProject { path: path.clone() })
            }
            (UserMemorySuggestRequestScope::Project, None) => {
                return Err(Error::Validation("this session has no project folder — suggest it as global".into()));
            }
        };
        let source = UserMemorySource::Agent(UserMemorySourceAgent {
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone().unwrap_or_else(|| agent.id.clone()),
            why: request.why.filter(|why| !why.is_empty()),
        });
        let suggestion = UserMemorySuggestion {
            text: request.text,
            category: request.category,
            domain: None,
            scope,
            proposal: None,
        };
        self.memories.suggest(suggestion, source)
    }
}

impl MemorySearch for AgentMemory {
    fn search<'a>(
        &'a self,
        agent_id: &'a str,
        query: &'a str,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<Arc<UserMemory>>, Error>> {
        Box::pin(async move {
            let agent = self.caller(Some(agent_id)).await?;
            AgentMemory::search(self, agent.as_ref(), None, query, limit)
        })
    }
}

impl MemorySuggestions for AgentMemory {
    fn suggest<'a>(
        &'a self,
        agent_id: &'a str,
        request: UserMemorySuggestRequest,
    ) -> BoxFuture<'a, Result<UserMemorySuggestResult, Error>> {
        Box::pin(async move {
            let agent = self.caller(Some(agent_id)).await?;
            self.may_suggest(agent.as_ref())?;
            match &agent {
                Some(agent) => AgentMemory::suggest(self, agent, request),
                None => Err(Error::PermissionDenied("only an agent can suggest a memory".into())),
            }
        })
    }
}
