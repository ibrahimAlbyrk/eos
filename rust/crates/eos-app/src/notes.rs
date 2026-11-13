//! Pages, the user's profile and memories: their stores over the data folder
//! and the CLAUDE.md files a session receives.

use std::sync::Arc;

use eos_core::Clock;
use eos_core::profile::ProfileBlockInput;
use eos_core::prompt::{MemoryScope, MemorySnapshot, ProfileRenderer, ProfileText};
use eos_core::store::{AvatarThumbnails, ConfigSource, PageStore, Store};
use eos_domain::memory_sources::resolve_memory_sources;
use eos_mod_profile::{PreviewContext, ProfileStores};
use eos_platform::DataPaths;
use eos_profile::{ProfileBlocks, received_memory_lines};
use eos_store_files::avatar_thumbnails::FileAvatarThumbnails;
use eos_store_files::claude_md::FileMemoryProvider;
use eos_store_files::memories::FileUserMemoryStore;
use eos_store_files::pages::FilePageStore;
use eos_store_files::profile::{FileUserAvatarStore, FileUserProfileStore};

/// The memory search tool, as the profile preview names it.
const SEARCH_MEMORY_TOOL: &str = "search_memory";

pub(crate) struct Notes {
    pub(crate) pages: Arc<dyn PageStore>,
    pub(crate) profile: ProfileStores,
    pub(crate) preview: PreviewContext,
    /// The avatar made small, kept beside the app icons.
    pub(crate) avatar_thumbnails: Arc<dyn AvatarThumbnails>,
}

impl Notes {
    /// Reads the pages, the profile and the memories of the data folder. The
    /// memory sources are the configured ones as of now; whether memory files
    /// are handed to every backend is read from the configuration at each use.
    pub(crate) fn open(
        paths: &DataPaths,
        clock: &Arc<dyn Clock>,
        workers: Arc<dyn Store>,
        config: Arc<dyn ConfigSource>,
    ) -> Self {
        let dir = paths.join("profile");
        let profile = Arc::new(FileUserProfileStore::open(&dir));
        let memories = Arc::new(FileUserMemoryStore::open(dir.join("memories"), clock.clone()));
        let current = config.current();
        let sources = resolve_memory_sources(current.memory.sources.iter().map(|(id, source)| (id.as_str(), source)));
        let user_home = eos_platform::home_dir().unwrap_or_default();
        Self {
            pages: Arc::new(FilePageStore::open(paths.join("pages"), clock.clone())),
            preview: PreviewContext {
                blocks: Arc::new(ProfileBlocks::new(profile.clone(), memories.clone())),
                memory: Arc::new(FileMemoryProvider::new(sources, user_home)),
                data_home: paths.home().to_owned(),
                memory_injected: Arc::new(move || config.current().memory.enabled),
                search_tool_name: SEARCH_MEMORY_TOOL.to_owned(),
            },
            avatar_thumbnails: Arc::new(FileAvatarThumbnails::new(
                &dir,
                paths.join("icon-cache").join("avatar"),
                eos_platform::host().desktop(),
            )),
            profile: ProfileStores { profile, avatars: Arc::new(FileUserAvatarStore::new(&dir)), memories, workers },
        }
    }
}

/// The user's profile as prompt text, for whoever assembles a system prompt:
/// the profile feature's block, without the lines the session already gets
/// from its memory files.
pub(crate) struct ProfilePrompt {
    context: PreviewContext,
}

impl ProfilePrompt {
    pub(crate) fn new(context: PreviewContext) -> Self {
        Self { context }
    }
}

impl ProfileRenderer for ProfilePrompt {
    fn render(&self, kind: &str, project: Option<&str>, memory: Option<&MemorySnapshot>) -> ProfileText {
        let cx = &self.context;
        let loaded;
        let snapshot = match memory {
            Some(snapshot) => snapshot,
            // No project still loads the user-level files: every session gets them.
            None => {
                let scope = match project {
                    Some(project) => MemoryScope { cwd: project.as_ref(), repo_root: None },
                    None => MemoryScope { cwd: &cx.data_home, repo_root: Some(&cx.data_home) },
                };
                loaded = cx.memory.load(scope);
                &loaded
            }
        };
        let known_lines = received_memory_lines(snapshot, kind, (cx.memory_injected)());
        let block = cx.blocks.block(&ProfileBlockInput {
            kind,
            project,
            known_lines: &known_lines,
            search_tool_name: Some(&cx.search_tool_name),
        });
        ProfileText { text: block.text, empty: block.empty }
    }
}
