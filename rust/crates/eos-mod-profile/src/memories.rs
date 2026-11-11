//! The one write path for the user's memories
//! (`core/src/services/UserMemoryService.ts`). Callers depend on the narrow
//! face they need: readers (prompt assembly, search), the suggestion sink
//! (agents, dreams — duplicates, declined ideas, the cap and the events are
//! handled here once), the editor (the user: keep, edit, delete) and sync.
//! Dismissing keeps a `dismissed` tombstone so the same idea is never
//! suggested again. Every change announces `user-memory:change`.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use eos_contracts::{
    DreamProposalKind, Num, UserMemory, UserMemoryCategory, UserMemoryChangeEvent, UserMemoryChangeEventAction,
    UserMemoryChangeEventBy, UserMemoryDomain, UserMemoryId, UserMemoryProposal, UserMemoryScope, UserMemorySource,
    UserMemoryStatus, UserMemoryTier,
};
use eos_core::profile::{
    UserMemoryReader, UserMemorySuggestResult, UserMemorySuggestion, UserMemorySuggestionSink, UserMemorySync,
};
use eos_core::store::UserMemoryStore;
use eos_core::{Clock, Error as CoreError, Ids};
use eos_domain::user_memory::{find_duplicate_memory, find_duplicate_proposal, normalize_memory_text, search_memories};
use eos_runtime::bus::Bus;

use crate::{Error, USER_MEMORY_CHANGE};

/// How many suggestions may wait for the user's review, per producer: an
/// agent cannot crowd out the others, and all dreams share one share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PendingCaps {
    /// Each agent, each import source, the user.
    pub per_producer: usize,
    /// Every dream together.
    pub dreams: usize,
}

impl Default for PendingCaps {
    fn default() -> Self {
        Self { per_producer: 5, dreams: 4 }
    }
}

/// A memory the user writes or edits to.
#[derive(Debug, Clone, PartialEq)]
pub struct MemoryInput {
    pub text: String,
    pub category: UserMemoryCategory,
    pub domain: Option<UserMemoryDomain>,
    pub scope: UserMemoryScope,
    pub tier: UserMemoryTier,
}

/// An edit: what is absent stays as it is.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MemoryPatch {
    pub text: Option<String>,
    pub category: Option<UserMemoryCategory>,
    pub domain: Option<UserMemoryDomain>,
    pub scope: Option<UserMemoryScope>,
    pub tier: Option<UserMemoryTier>,
}

pub struct UserMemoryService {
    store: Arc<dyn UserMemoryStore>,
    clock: Arc<dyn Clock>,
    ids: Arc<dyn Ids>,
    bus: Bus,
    caps: PendingCaps,
    /// One change at a time: reading, deciding, writing and announcing are
    /// one step, so two suggestions cannot both pass the duplicate check.
    changing: Mutex<()>,
}

impl std::fmt::Debug for UserMemoryService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UserMemoryService").field("caps", &self.caps).finish_non_exhaustive()
    }
}

/// Whose share of the review queue a suggestion counts against.
fn producer_key(source: &UserMemorySource) -> String {
    match source {
        UserMemorySource::Agent(agent) => format!("agent:{}", agent.agent_id),
        UserMemorySource::Import(import) => format!("import:{}", import.from),
        UserMemorySource::Dream(_) => "dream".to_owned(),
        UserMemorySource::User => "user".to_owned(),
    }
}

fn is_change(proposal: Option<&UserMemoryProposal>) -> Option<&UserMemoryProposal> {
    proposal.filter(|p| p.kind != DreamProposalKind::New)
}

use UserMemoryChangeEventAction as Action;
use UserMemoryChangeEventBy as By;

impl UserMemoryService {
    pub fn new(
        store: Arc<dyn UserMemoryStore>,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn Ids>,
        bus: Bus,
        caps: PendingCaps,
    ) -> Self {
        Self { store, clock, ids, bus, caps, changing: Mutex::new(()) }
    }

    fn change(&self) -> MutexGuard<'_, ()> {
        self.changing.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every memory, tombstones included: readers filter by status.
    pub fn list(&self) -> Vec<Arc<UserMemory>> {
        self.store.list()
    }

    pub fn get(&self, id: &str) -> Result<Arc<UserMemory>, CoreError> {
        self.store.get(id).ok_or_else(|| CoreError::not_found("memory", id))
    }

    pub fn search(&self, query: &str, project: Option<&str>, limit: usize) -> Vec<Arc<UserMemory>> {
        let all = self.store.list();
        search_memories(&all, query, project, limit).into_iter().cloned().collect()
    }

    pub fn suggest(
        &self,
        input: UserMemorySuggestion,
        source: UserMemorySource,
    ) -> Result<UserMemorySuggestResult, CoreError> {
        let _changing = self.change();
        let text = normalize_memory_text(&input.text);
        let all = self.store.list();
        let change = is_change(input.proposal.as_ref());
        if let Some(proposal) = change {
            self.require_kept(&proposal.targets)?;
        }
        let duplicate = match change {
            Some(proposal) => find_duplicate_proposal(&text, proposal, &all),
            None => find_duplicate_memory(&text, &input.scope, &all),
        };
        if let Some(memory) = duplicate {
            let declined = memory.status == UserMemoryStatus::Dismissed;
            return Ok(UserMemorySuggestResult { memory: memory.clone(), duplicate: true, declined });
        }
        let key = producer_key(&source);
        let cap = if key == "dream" { self.caps.dreams } else { self.caps.per_producer };
        let waiting = |m: &&Arc<UserMemory>| m.status == UserMemoryStatus::Suggested && producer_key(&m.source) == key;
        if all.iter().filter(waiting).count() >= cap {
            return Err(CoreError::LimitExceeded(format!(
                "{cap} suggestions are already waiting for the user's review"
            )));
        }
        let new = MemoryInput {
            text,
            category: input.category,
            domain: input.domain,
            scope: input.scope,
            tier: UserMemoryTier::Always,
        };
        let memory = self.insert(new, UserMemoryStatus::Suggested, source, input.proposal)?;
        Ok(UserMemorySuggestResult { memory, duplicate: false, declined: false })
    }

    /// The user writes one: kept at once.
    pub fn create(&self, input: MemoryInput) -> Result<Arc<UserMemory>, CoreError> {
        let _changing = self.change();
        let input = MemoryInput { text: normalize_memory_text(&input.text), ..input };
        self.insert(input, UserMemoryStatus::Active, UserMemorySource::User, None)
    }

    pub fn update(&self, id: &str, patch: MemoryPatch, base_rev: Option<i64>) -> Result<Arc<UserMemory>, Error> {
        let _changing = self.change();
        let cur = self.get(id)?;
        if base_rev.is_some_and(|rev| rev != cur.rev) {
            return Err(Error::StaleMemory(cur));
        }
        let next = UserMemory {
            text: patch.text.map_or_else(|| cur.text.clone(), |text| normalize_memory_text(&text)),
            category: patch.category.unwrap_or(cur.category),
            domain: patch.domain.or(cur.domain),
            scope: patch.scope.unwrap_or_else(|| cur.scope.clone()),
            tier: patch.tier.unwrap_or(cur.tier),
            ..UserMemory::clone(&cur)
        };
        if next == *cur { Ok(cur) } else { Ok(self.commit(next, Action::Updated, By::User)?) }
    }

    pub fn remove(&self, id: &str) -> Result<(), CoreError> {
        let _changing = self.change();
        let cur = self.get(id)?;
        self.drop_memory(&cur)
    }

    /// Keeps a suggestion, applying what it proposes. Answers the memory the
    /// user ends up with: `None` when the proposal retired one.
    pub fn approve(&self, id: &str) -> Result<Option<Arc<UserMemory>>, CoreError> {
        let _changing = self.change();
        self.approve_locked(id)
    }

    fn approve_locked(&self, id: &str) -> Result<Option<Arc<UserMemory>>, CoreError> {
        let cur = self.get(id)?;
        match cur.status {
            UserMemoryStatus::Active => return Ok(Some(cur)),
            UserMemoryStatus::Dismissed => return Err(CoreError::Validation(format!("memory {id} was dismissed"))),
            UserMemoryStatus::Suggested => {}
        }
        let kept = || UserMemory { proposal: None, status: UserMemoryStatus::Active, ..UserMemory::clone(&cur) };
        let Some(proposal) = is_change(cur.proposal.as_ref()) else {
            return Ok(Some(self.commit(kept(), Action::Approved, By::User)?));
        };
        let targets = self.require_kept(&proposal.targets)?;
        if proposal.kind == DreamProposalKind::Merge {
            for target in &targets {
                self.drop_memory(target)?;
            }
            return Ok(Some(self.commit(kept(), Action::Approved, By::User)?));
        }
        // The other kinds change their first target.
        let Some(target) = targets.first() else {
            return Err(CoreError::Conflict(format!("the proposal names no memory to change ({id})")));
        };
        self.consume(&cur)?;
        let changed = match proposal.kind {
            DreamProposalKind::Update => {
                UserMemory { text: cur.text.clone(), domain: cur.domain.or(target.domain), ..UserMemory::clone(target) }
            }
            DreamProposalKind::Promote => UserMemory { scope: UserMemoryScope::Global, ..UserMemory::clone(target) },
            _ => {
                self.drop_memory(target)?;
                return Ok(None);
            }
        };
        Ok(Some(self.commit(changed, Action::Updated, By::User)?))
    }

    pub fn dismiss(&self, id: &str) -> Result<(), CoreError> {
        let _changing = self.change();
        let cur = self.get(id)?;
        if cur.status != UserMemoryStatus::Suggested {
            return Err(CoreError::Validation(format!("memory {id} is not waiting for review")));
        }
        self.commit(
            UserMemory { status: UserMemoryStatus::Dismissed, ..UserMemory::clone(&cur) },
            Action::Dismissed,
            By::User,
        )?;
        Ok(())
    }

    /// Keeps every suggestion that still applies: a proposal whose target an
    /// earlier one removed is left waiting.
    pub fn approve_all(&self) -> Result<Vec<Option<Arc<UserMemory>>>, CoreError> {
        let _changing = self.change();
        let mut kept = Vec::new();
        for memory in self.store.list().iter().filter(|m| m.status == UserMemoryStatus::Suggested) {
            match self.approve_locked(&memory.id.0) {
                Ok(result) => kept.push(result),
                Err(CoreError::Conflict(_)) => {}
                Err(e) => return Err(e),
            }
        }
        Ok(kept)
    }

    fn require_kept(&self, ids: &[UserMemoryId]) -> Result<Vec<Arc<UserMemory>>, CoreError> {
        ids.iter()
            .map(|id| {
                self.store
                    .get(&id.0)
                    .filter(|target| target.status == UserMemoryStatus::Active)
                    .ok_or_else(|| CoreError::Conflict(format!("the memory this changes is gone ({})", id.0)))
            })
            .collect()
    }

    fn insert(
        &self,
        input: MemoryInput,
        status: UserMemoryStatus,
        source: UserMemorySource,
        proposal: Option<UserMemoryProposal>,
    ) -> Result<Arc<UserMemory>, CoreError> {
        let now = Num::from(self.clock.now_ms());
        let by = match &source {
            UserMemorySource::Agent(_) => By::Agent,
            UserMemorySource::Dream(_) => By::Dream,
            _ => By::User,
        };
        let memory = self.store.put(UserMemory {
            id: UserMemoryId(self.ids.user_memory_id()),
            text: input.text,
            category: input.category,
            domain: input.domain,
            scope: input.scope,
            tier: input.tier,
            status,
            source,
            proposal,
            rev: 0,
            created_at: now,
            updated_at: now,
        })?;
        self.announce(&memory, Action::Created, by);
        Ok(memory)
    }

    fn commit(&self, mut next: UserMemory, action: Action, by: By) -> Result<Arc<UserMemory>, CoreError> {
        next.rev += 1;
        next.updated_at = Num::from(self.clock.now_ms());
        let saved = self.store.put(next)?;
        self.announce(&saved, action, by);
        Ok(saved)
    }

    /// A kept proposal is spent once applied to its target.
    fn consume(&self, suggestion: &UserMemory) -> Result<(), CoreError> {
        self.store.remove(&suggestion.id.0)?;
        self.announce(suggestion, Action::Approved, By::User);
        Ok(())
    }

    fn drop_memory(&self, memory: &UserMemory) -> Result<(), CoreError> {
        self.store.remove(&memory.id.0)?;
        self.announce(memory, Action::Deleted, By::User);
        Ok(())
    }

    /// Called with the change lock held, after the write returned.
    fn announce(&self, memory: &UserMemory, action: Action, by: By) {
        let event = UserMemoryChangeEvent { id: memory.id.clone(), action, status: memory.status, by };
        self.bus.publish(&USER_MEMORY_CHANGE, &event);
    }
}

impl UserMemoryReader for UserMemoryService {
    fn list(&self) -> Vec<Arc<UserMemory>> {
        UserMemoryService::list(self)
    }

    fn search(&self, query: &str, project: Option<&str>, limit: usize) -> Vec<Arc<UserMemory>> {
        UserMemoryService::search(self, query, project, limit)
    }
}

impl UserMemorySuggestionSink for UserMemoryService {
    fn suggest(
        &self,
        input: UserMemorySuggestion,
        source: UserMemorySource,
    ) -> Result<UserMemorySuggestResult, CoreError> {
        UserMemoryService::suggest(self, input, source)
    }
}

impl UserMemorySync for UserMemoryService {
    fn list(&self) -> Vec<Arc<UserMemory>> {
        UserMemoryService::list(self)
    }

    fn apply_synced(&self, memory: UserMemory) -> Result<Arc<UserMemory>, CoreError> {
        let _changing = self.change();
        let cur = self.store.get(&memory.id.0);
        let saved = self.store.put(UserMemory { rev: cur.as_ref().map_or(0, |cur| cur.rev + 1), ..memory })?;
        let action = if cur.is_some() { Action::Updated } else { Action::Created };
        self.announce(&saved, action, By::Sync);
        Ok(saved)
    }

    fn remove_synced(&self, id: &str) -> Result<(), CoreError> {
        let _changing = self.change();
        let Some(cur) = self.store.get(id) else { return Ok(()) };
        self.store.remove(id)?;
        self.announce(&cur, Action::Deleted, By::Sync);
        Ok(())
    }
}
