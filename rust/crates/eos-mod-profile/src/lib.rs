//! Who the user is, for every agent: the profile (`<home>/profile/profile.json`),
//! its avatar and the user's memories (`<home>/profile/memories`).
//!
//! - [`UserProfileService`] and [`UserMemoryService`] are the one write path
//!   each: every change bumps a revision and announces `profile:change` /
//!   `user-memory:change`.
//! - Agents only search and suggest ([`AgentMemory`]); keeping, editing and
//!   deleting a memory, and every profile write, need the user's window.
//! - The text agents get is rendered by `eos-profile`; the preview route
//!   answers with that same text.

mod agents;
mod memories;
mod notify;
mod profile;
mod routes;

use std::sync::{Arc, Mutex, PoisonError};

use eos_contracts::stream::topics;
use eos_contracts::{UserMemory, UserMemoryChangeEvent, UserMemoryChangeEventBy, UserProfile, UserProfileChangeEvent};
use eos_core::profile::{
    MemorySearch, MemorySuggestions, UserMemoryReader, UserMemorySuggestionSink, UserMemorySync, UserProfileReader,
    UserProfileSync,
};
use eos_core::store::{AvatarThumbnails, Store, UserAvatarStore, UserMemoryStore, UserProfileStore};
use eos_core::{Clock, Ids};
use eos_runtime::bus::{Bus, Subscription, Topic, TopicDecl};
use eos_runtime::module::{Module, ModuleError, Opaque, SyncContribution};
use eos_runtime::router::{BoxFuture, RouteDef};

pub use agents::{AgentMemory, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX};
pub use memories::{MemoryInput, MemoryPatch, PendingCaps, UserMemoryService};
pub use notify::MEMORY_NOTIFY_DELAY;
pub use profile::UserProfileService;
pub use routes::profile::PreviewContext;

pub const PROFILE_CHANGE: Topic<UserProfileChangeEvent> = Topic::new(topics::PROFILE_CHANGE);
pub const USER_MEMORY_CHANGE: Topic<UserMemoryChangeEvent> = Topic::new(topics::USER_MEMORY_CHANGE);

#[derive(Debug, Clone, thiserror::Error)]
pub enum Error {
    /// The profile changed since the revision the caller edited. Carries the
    /// profile as it is now.
    #[error("profile changed since the revision you edited (now rev {})", .0.rev)]
    StaleProfile(Arc<UserProfile>),
    /// The memory changed since the revision the caller edited.
    #[error("memory {} changed since the revision you edited (now rev {})", .0.id.0, .0.rev)]
    StaleMemory(Arc<UserMemory>),
    #[error(transparent)]
    Core(#[from] eos_core::Error),
}

/// The stores the feature keeps its data in.
#[derive(Clone)]
pub struct ProfileStores {
    pub profile: Arc<dyn UserProfileStore>,
    pub avatars: Arc<dyn UserAvatarStore>,
    pub memories: Arc<dyn UserMemoryStore>,
    /// The database, for the worker rows that say which project and backend
    /// an agent belongs to.
    pub workers: Arc<dyn Store>,
}

impl std::fmt::Debug for ProfileStores {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileStores").finish_non_exhaustive()
    }
}

pub struct ProfileModule {
    profile: Arc<UserProfileService>,
    agents: Arc<AgentMemory>,
    preview: Arc<PreviewContext>,
    clock: Arc<dyn Clock>,
    bus: Bus,
    suggestions: Mutex<Option<Subscription>>,
    thumbnails: Option<Arc<dyn AvatarThumbnails>>,
}

impl std::fmt::Debug for ProfileModule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileModule").finish_non_exhaustive()
    }
}

impl ProfileModule {
    pub fn new(
        stores: ProfileStores,
        preview: PreviewContext,
        caps: PendingCaps,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn Ids>,
        bus: Bus,
    ) -> Self {
        let profile = Arc::new(UserProfileService::new(stores.profile, stores.avatars, clock.clone(), bus.clone()));
        let memories = Arc::new(UserMemoryService::new(stores.memories, clock.clone(), ids, bus.clone(), caps));
        let agents = Arc::new(AgentMemory::new(memories, profile.clone(), stores.workers));
        Self {
            profile,
            agents,
            preview: Arc::new(preview),
            clock,
            bus,
            suggestions: Mutex::new(None),
            thumbnails: None,
        }
    }

    /// Lets `GET /api/profile/avatar?size=` answer a small copy. Without it the route
    /// answers the stored avatar at any size.
    pub fn with_avatar_thumbnails(mut self, thumbnails: Arc<dyn AvatarThumbnails>) -> Self {
        self.thumbnails = Some(thumbnails);
        self
    }

    /// The profile, for whoever only reads it (a dream's settings).
    pub fn profile_reader(&self) -> Arc<dyn UserProfileReader> {
        self.profile.clone()
    }

    pub fn memory_reader(&self) -> Arc<dyn UserMemoryReader> {
        self.agents.memories.clone()
    }

    /// Where a producer other than an agent (a dream) files its suggestions.
    pub fn suggestion_sink(&self) -> Arc<dyn UserMemorySuggestionSink> {
        self.agents.memories.clone()
    }

    /// `search_memory` for the agent tools.
    pub fn memory_search(&self) -> Arc<dyn MemorySearch> {
        self.agents.clone()
    }

    /// `suggest_memory` for the agent tools.
    pub fn memory_suggestions(&self) -> Arc<dyn MemorySuggestions> {
        self.agents.clone()
    }

    pub fn profile_sync(&self) -> Arc<dyn UserProfileSync> {
        self.profile.clone()
    }

    pub fn memory_sync(&self) -> Arc<dyn UserMemorySync> {
        self.agents.memories.clone()
    }
}

impl Module for ProfileModule {
    fn id(&self) -> &'static str {
        "profile"
    }

    fn routes(&self) -> Vec<RouteDef> {
        let mut routes = routes::profile::all(&self.profile, &self.preview, self.thumbnails.clone());
        routes.extend(routes::memories::all(&self.agents));
        routes
    }

    fn topics(&self) -> Vec<TopicDecl> {
        vec![PROFILE_CHANGE.decl(), USER_MEMORY_CHANGE.decl()]
    }

    /// The handles are an `Arc<dyn UserProfileSync>` (profile fields and the
    /// avatar) and an `Arc<dyn UserMemorySync>`: the sync feature builds its
    /// domains over them. A memory change that sync itself applied is not a
    /// local edit.
    fn sync(&self) -> Vec<SyncContribution> {
        let profile: Opaque = Arc::new(self.profile_sync());
        let memory: Opaque = Arc::new(self.memory_sync());
        let made_here = |event: &eos_runtime::bus::Event| {
            event.payload_as::<UserMemoryChangeEvent>().is_ok_and(|change| change.by != UserMemoryChangeEventBy::Sync)
        };
        vec![
            SyncContribution {
                domain: "profile",
                handle: profile.clone(),
                change_topic: Some(PROFILE_CHANGE.name()),
                is_local: None,
            },
            SyncContribution { domain: "avatar", handle: profile, change_topic: None, is_local: None },
            SyncContribution {
                domain: "memory",
                handle: memory,
                change_topic: Some(USER_MEMORY_CHANGE.name()),
                is_local: Some(Arc::new(made_here)),
            },
        ]
    }

    fn start(&self) -> BoxFuture<'_, Result<(), ModuleError>> {
        Box::pin(async move {
            let watch = notify::watch(&self.bus, self.agents.memories.clone(), self.clock.clone());
            *self.suggestions.lock().unwrap_or_else(PoisonError::into_inner) = Some(watch);
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        self.suggestions.lock().unwrap_or_else(PoisonError::into_inner).take();
        Box::pin(std::future::ready(()))
    }
}
