//! What the profile feature offers the rest of the app:
//!
//! - the prompt block that tells an agent who the user is ([`UserProfileBlocks`]);
//! - memory for the agent tools ([`MemorySearch`], [`MemorySuggestions`]): what
//!   the memory routes answer the same agent;
//! - memory for any producer of suggestions, such as a dream
//!   ([`UserMemoryReader`], [`UserMemorySuggestionSink`], [`UserProfileReader`]);
//! - the write paths sync applies another computer's data through
//!   ([`UserProfileSync`], [`UserMemorySync`]).

use std::sync::Arc;

use eos_contracts::{
    Num, ProfileLanguage, UserMemory, UserMemoryCategory, UserMemoryDomain, UserMemoryProposal, UserMemoryScope,
    UserMemorySource, UserMemorySuggestRequest, UserProfile, UserProfileSharing, UserProfileStyle, UserProfileWork,
};

use crate::store::UserAvatar;
use crate::{BoxFuture, Error};

/// One session's facts, as far as the profile block depends on them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProfileBlockInput<'a> {
    /// The session's backend kind: the user may withhold the profile from a kind.
    pub kind: &'a str,
    /// The folder the session works on (a worktree resolves to its source
    /// repository); project memories render only inside theirs.
    pub project: Option<&'a str>,
    /// Lines the session already receives from CLAUDE.md-style files: the
    /// block never repeats them.
    pub known_lines: &'a [String],
    /// The memory search tool as this session names it. `None`: the block
    /// does not mention the memories it left out.
    pub search_tool_name: Option<&'a str>,
}

/// The text for `{{USER_PROFILE}}` and what went into it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileBlock {
    pub text: String,
    /// The text's estimated size in tokens.
    pub tokens: i64,
    /// The memories rendered into the text, in order.
    pub included_ids: Vec<String>,
    /// Always-on memories that did not fit the budget.
    pub overflow: usize,
    /// True when the text is the stock preferences: nothing of the user's is in it.
    pub empty: bool,
    /// True when the user withholds the profile from this backend kind.
    pub withheld: bool,
    /// The profile's token budget.
    pub budget_tokens: i64,
}

/// Renders the profile and the always-on memories for a session. The spawn
/// path and the profile preview both call this, so what the user previews is
/// what agents get.
pub trait UserProfileBlocks: Send + Sync + 'static {
    fn block(&self, input: &ProfileBlockInput<'_>) -> ProfileBlock;
}

/// The user's profile; the empty one when they never saved any.
pub trait UserProfileReader: Send + Sync + 'static {
    fn get(&self) -> Arc<UserProfile>;
}

/// Memories as prompt assembly, search and a producer of suggestions read them.
pub trait UserMemoryReader: Send + Sync + 'static {
    /// Every memory, pending suggestions and dismissed tombstones included:
    /// readers filter by status.
    fn list(&self) -> Vec<Arc<UserMemory>>;
    /// Kept memories a session in `project` may see, ranked by how many of
    /// the query's words they hold; an empty query lists the newest first.
    fn search(&self, query: &str, project: Option<&str>, limit: usize) -> Vec<Arc<UserMemory>>;
}

/// What a producer proposes. `proposal` says what keeping it changes; absent,
/// it is a new memory.
#[derive(Debug, Clone, PartialEq)]
pub struct UserMemorySuggestion {
    pub text: String,
    pub category: UserMemoryCategory,
    pub domain: Option<UserMemoryDomain>,
    pub scope: UserMemoryScope,
    pub proposal: Option<UserMemoryProposal>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UserMemorySuggestResult {
    /// The new suggestion, or the memory that already says it.
    pub memory: Arc<UserMemory>,
    pub duplicate: bool,
    /// The match is one the user dismissed: the producer should not try again.
    pub declined: bool,
}

/// Where any producer (an agent, a dream) files a suggestion for the user's
/// review. Duplicates, declined ideas, the cap per producer and the change
/// event are handled here once, for all of them. The user keeps a suggestion
/// through the memory routes; keeping applies its proposal.
pub trait UserMemorySuggestionSink: Send + Sync + 'static {
    /// [`Error::Conflict`] when a memory the proposal changes is gone,
    /// [`Error::LimitExceeded`] when the producer's suggestions already fill
    /// its share of the review queue.
    fn suggest(&self, input: UserMemorySuggestion, source: UserMemorySource) -> Result<UserMemorySuggestResult, Error>;
}

/// `search_memory` for one agent: its own session's project, at most 20
/// results. [`Error::PermissionDenied`] when the user withholds their profile
/// from the agent's backend kind.
pub trait MemorySearch: Send + Sync + 'static {
    fn search<'a>(
        &'a self,
        agent_id: &'a str,
        query: &'a str,
        limit: usize,
    ) -> BoxFuture<'a, Result<Vec<Arc<UserMemory>>, Error>>;
}

/// `suggest_memory` for one agent. [`Error::PermissionDenied`] when the id
/// names no agent or the profile is withheld from its backend kind;
/// [`Error::Validation`] for a project suggestion from a session with no folder.
pub trait MemorySuggestions: Send + Sync + 'static {
    fn suggest<'a>(
        &'a self,
        agent_id: &'a str,
        request: UserMemorySuggestRequest,
    ) -> BoxFuture<'a, Result<UserMemorySuggestResult, Error>>;
}

/// The profile fields that follow the user to their other computers; `None`
/// leaves a field as it is here. Never this computer's revision, avatar
/// extension or dreaming settings.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SyncedProfileFields {
    pub identity: Option<SyncedIdentity>,
    pub language: Option<SyncedLanguage>,
    pub work: Option<UserProfileWork>,
    pub style: Option<UserProfileStyle>,
    pub instructions: Option<String>,
    pub sharing: Option<UserProfileSharing>,
    pub budget_tokens: Option<i64>,
    pub onboarded_at: Option<Option<Num>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncedIdentity {
    pub full_name: String,
    pub call_name: String,
    pub handle: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SyncedLanguage {
    pub chat: Option<ProfileLanguage>,
    pub code: Option<ProfileLanguage>,
}

/// The profile and its avatar as the sync feature reads and writes them.
/// Changes applied here are announced like local ones.
pub trait UserProfileSync: Send + Sync + 'static {
    fn get(&self) -> Arc<UserProfile>;
    /// Stores the fields as given; nothing changes when they already hold.
    fn apply_synced(&self, fields: SyncedProfileFields) -> Result<Arc<UserProfile>, Error>;
    fn avatar(&self) -> Result<Option<UserAvatar>, Error>;
    fn set_avatar(&self, bytes: &[u8]) -> Result<Arc<UserProfile>, Error>;
    fn clear_avatar(&self) -> Result<Arc<UserProfile>, Error>;
}

/// The memories as the sync feature reads and writes them.
pub trait UserMemorySync: Send + Sync + 'static {
    fn list(&self) -> Vec<Arc<UserMemory>>;
    /// Stores the memory as given, timestamps included; only the revision is
    /// this computer's own (the one in `memory` is ignored). Announced as a
    /// change made by sync.
    fn apply_synced(&self, memory: UserMemory) -> Result<Arc<UserMemory>, Error>;
    /// Removes the memory if it is here.
    fn remove_synced(&self, id: &str) -> Result<(), Error>;
}
