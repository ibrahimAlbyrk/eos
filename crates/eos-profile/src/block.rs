//! What one session gets for `{{USER_PROFILE}}`.

use std::borrow::Borrow;
use std::sync::Arc;

use eos_contracts::{UserMemory, UserProfile};
use eos_core::profile::{ProfileBlock, ProfileBlockInput, UserProfileBlocks};
use eos_core::prompt::MemorySnapshot;
use eos_core::store::{UserMemoryStore, UserProfileStore};
use eos_domain::text::estimate_tokens;
use eos_domain::user_profile::empty_user_profile;

use crate::render::{DEFAULT_USER_PREFERENCES, RenderOptions, render_user_profile};

/// The rendered profile and always-on memories for a session, or the stock
/// preferences when the user withholds the profile from its backend kind.
pub fn build_user_profile_block<M: Borrow<UserMemory>>(
    profile: &UserProfile,
    memories: &[M],
    input: &ProfileBlockInput<'_>,
) -> ProfileBlock {
    if profile.sharing.withhold_from.iter().any(|kind| kind == input.kind) {
        return ProfileBlock {
            text: DEFAULT_USER_PREFERENCES.to_owned(),
            tokens: estimate_tokens(DEFAULT_USER_PREFERENCES),
            included_ids: Vec::new(),
            overflow: 0,
            empty: true,
            withheld: true,
            budget_tokens: profile.budget_tokens,
        };
    }
    let options = RenderOptions {
        project: input.project,
        known_lines: input.known_lines,
        search_tool_name: input.search_tool_name,
    };
    let rendered = render_user_profile(profile, memories, &options);
    ProfileBlock {
        text: rendered.text,
        tokens: rendered.tokens,
        included_ids: rendered.included_ids,
        overflow: rendered.overflow,
        empty: rendered.empty,
        withheld: false,
        budget_tokens: profile.budget_tokens,
    }
}

/// The memory-file lines a session of `kind` actually receives: files its
/// backend loads itself, plus every file when the app injects memory.
pub fn received_memory_lines(snapshot: &MemorySnapshot, kind: &str, injected: bool) -> Vec<String> {
    snapshot
        .docs
        .iter()
        .filter(|doc| injected || doc.native_for.iter().any(|native| native == kind))
        .flat_map(|doc| doc.content.split('\n').map(str::to_owned))
        .collect()
}

/// [`UserProfileBlocks`] over the stored profile and memories.
pub struct ProfileBlocks {
    profile: Arc<dyn UserProfileStore>,
    memories: Arc<dyn UserMemoryStore>,
}

impl std::fmt::Debug for ProfileBlocks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileBlocks").finish_non_exhaustive()
    }
}

impl ProfileBlocks {
    pub fn new(profile: Arc<dyn UserProfileStore>, memories: Arc<dyn UserMemoryStore>) -> Self {
        Self { profile, memories }
    }
}

impl UserProfileBlocks for ProfileBlocks {
    fn block(&self, input: &ProfileBlockInput<'_>) -> ProfileBlock {
        let memories = self.memories.list();
        match self.profile.get() {
            Some(profile) => build_user_profile_block(&profile, &memories, input),
            None => build_user_profile_block(&empty_user_profile(), &memories, input),
        }
    }
}
