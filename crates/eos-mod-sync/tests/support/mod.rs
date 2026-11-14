//! One computer per call: real file stores in a temporary data folder, the
//! real services, the real crypto and the HTTP vault client — against the
//! in-memory relay vault on a loopback port. Only the git lookup is faked.

#![allow(dead_code, clippy::unwrap_used)]

use std::sync::Arc;
use std::time::Duration;

use eos_core::git::ProjectKeys;
use eos_core::net::sync::SyncDomain;
use eos_core::pages::PageSync;
use eos_core::profile::{UserMemorySync, UserProfileSync};
use eos_core::{Alphabet, BoxFuture, Ids};
use eos_kit_net::{ClientOptions, http_client};
use eos_mod_pages::{PAGES_CHANGE, PageService};
use eos_mod_profile::{PROFILE_CHANGE, PendingCaps, USER_MEMORY_CHANGE, UserMemoryService, UserProfileService};
use eos_mod_sync::{SyncModule, SyncParts, SyncService, SyncServiceDeps, Timing};
use eos_runtime::bus::{Filter, Subscription};
use eos_runtime::module::{Module, Opaque, SyncContribution};
use eos_runtime::{Kernel, KernelOptions};
use eos_store_files::memories::FileUserMemoryStore;
use eos_store_files::pages::FilePageStore;
use eos_store_files::profile::{FileUserAvatarStore, FileUserProfileStore};
use eos_store_files::sync_dir::FileDirDomain;
use eos_sync_vault::{FileSyncIdentityStore, FileSyncStateStore, RelayAccounts};
use eos_testkit::{FakeClock, SeqIds, TempHome};
use tokio::sync::Notify;

/// A folder travels as itself: `path:<abs>`.
pub(crate) struct PathKeys;

impl ProjectKeys for PathKeys {
    fn to_key<'a>(&'a self, path: &'a str) -> BoxFuture<'a, String> {
        Box::pin(std::future::ready(format!("path:{path}")))
    }
    fn to_path<'a>(&'a self, key: &'a str, _hint: &'a str) -> BoxFuture<'a, String> {
        Box::pin(std::future::ready(key.trim_start_matches("path:").to_owned()))
    }
    fn find_path<'a>(&'a self, _key: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(std::future::ready(None))
    }
}

/// One repository, checked out at `root` on this computer.
pub(crate) struct RepoAt(pub(crate) &'static str);

const REPO: &str = "git:github.com/o/eos";

impl ProjectKeys for RepoAt {
    fn to_key<'a>(&'a self, path: &'a str) -> BoxFuture<'a, String> {
        let key = match path.strip_prefix(self.0) {
            Some("") => REPO.to_owned(),
            Some(sub) => format!("{REPO}#{}", sub.trim_start_matches('/')),
            None => format!("path:{path}"),
        };
        Box::pin(std::future::ready(key))
    }
    fn to_path<'a>(&'a self, key: &'a str, hint: &'a str) -> BoxFuture<'a, String> {
        let path = match key.strip_prefix(REPO) {
            Some(sub) => format!("{}{}", self.0, sub.replacen('#', "/", 1)),
            None => hint.to_owned(),
        };
        Box::pin(std::future::ready(path))
    }
    fn find_path<'a>(&'a self, _key: &'a str) -> BoxFuture<'a, Option<String>> {
        Box::pin(std::future::ready(None))
    }
}

/// Counting ids that start with this computer's letter, so two computers
/// never mint the same one.
struct MacIds(SeqIds, u8);

impl Ids for MacIds {
    fn token(&self, alphabet: Alphabet, len: usize) -> String {
        let mut token = self.0.token(alphabet, len).into_bytes();
        if let Some(first) = token.first_mut() {
            *first = self.1;
        }
        String::from_utf8(token).unwrap()
    }
}

/// Short waits, so a test never sits out the real ones.
pub(crate) fn fast() -> Timing {
    Timing {
        long_poll: Duration::from_secs(5),
        local_debounce: Duration::from_millis(20),
        sweep: Duration::from_secs(60),
        backoff: vec![Duration::from_millis(50)],
        show_job_after: Duration::from_millis(1500),
    }
}

pub(crate) struct Mac {
    pub(crate) home: TempHome,
    pub(crate) clock: Arc<FakeClock>,
    pub(crate) kernel: Kernel,
    pub(crate) profile: Arc<UserProfileService>,
    pub(crate) memories: Arc<UserMemoryService>,
    pub(crate) pages: Arc<PageService>,
    pub(crate) module: Arc<SyncModule>,
    pub(crate) sync: Arc<SyncService>,
    /// Rings whenever anything is announced on this computer.
    pub(crate) rang: Arc<Notify>,
    _heard: Subscription,
}

impl Mac {
    /// `relay_url`: the relay a new account would be created on. `letter`
    /// (a hex digit) keeps this computer's ids apart from the others'.
    pub(crate) async fn new(relay_url: Option<String>, name: &str, letter: u8, rang: &Arc<Notify>) -> Self {
        Self::with(relay_url, name, letter, rang, fast(), Vec::new()).await
    }

    pub(crate) async fn with(
        relay_url: Option<String>,
        name: &str,
        letter: u8,
        rang: &Arc<Notify>,
        timing: Timing,
        extra: Vec<Arc<dyn SyncDomain>>,
    ) -> Self {
        let home = TempHome::new();
        let clock = Arc::new(FakeClock::new());
        let ids: Arc<dyn Ids> = Arc::new(MacIds(SeqIds::new(), letter));
        let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
        let bus = kernel.bus.clone();
        let profile_dir = home.join("profile");
        let profile = Arc::new(UserProfileService::new(
            Arc::new(FileUserProfileStore::open(&profile_dir)),
            Arc::new(FileUserAvatarStore::new(&profile_dir)),
            clock.clone(),
            bus.clone(),
        ));
        let memories = Arc::new(UserMemoryService::new(
            Arc::new(FileUserMemoryStore::open(profile_dir.join("memories"), clock.clone())),
            clock.clone(),
            ids.clone(),
            bus.clone(),
            PendingCaps::default(),
        ));
        let pages = Arc::new(PageService::new(
            Arc::new(FilePageStore::open(home.join("pages"), clock.clone())),
            clock.clone(),
            ids,
            bus.clone(),
        ));

        // What the profile and pages features contribute through `Module::sync`.
        let profile_handle: Opaque = Arc::new(profile.clone() as Arc<dyn UserProfileSync>);
        let memory_handle: Opaque = Arc::new(memories.clone() as Arc<dyn UserMemorySync>);
        let page_handle: Opaque = Arc::new(pages.clone() as Arc<dyn PageSync>);
        let made_here = |event: &eos_runtime::bus::Event| {
            event.payload_as::<serde_json::Value>().is_ok_and(|change| change["by"] != "sync")
        };
        let contributions = vec![
            SyncContribution {
                domain: "page",
                handle: page_handle,
                change_topic: Some(PAGES_CHANGE.name()),
                is_local: None,
            },
            SyncContribution {
                domain: "profile",
                handle: profile_handle.clone(),
                change_topic: Some(PROFILE_CHANGE.name()),
                is_local: None,
            },
            SyncContribution { domain: "avatar", handle: profile_handle, change_topic: None, is_local: None },
            SyncContribution {
                domain: "memory",
                handle: memory_handle,
                change_topic: Some(USER_MEMORY_CHANGE.name()),
                is_local: Some(Arc::new(made_here)),
            },
        ];
        let mut folders: Vec<Arc<dyn SyncDomain>> = vec![
            Arc::new(FileDirDomain::templates(home.join("templates"), clock.clone())),
            Arc::new(FileDirDomain::workers(home.join("workers"), clock.clone())),
        ];
        folders.extend(extra);
        let sync_dir = home.join("sync");
        let module = Arc::new(
            SyncModule::new(SyncParts {
                service: SyncServiceDeps {
                    identities: Arc::new(FileSyncIdentityStore::new(&sync_dir)),
                    state: Arc::new(FileSyncStateStore::new(&sync_dir, clock.clone())),
                    accounts: Arc::new(RelayAccounts::new(http_client(&ClientOptions::new("eos-test")).unwrap())),
                    relay_url: Arc::new(move || relay_url.clone()),
                    device: {
                        let name = name.to_owned();
                        Arc::new(move || name.clone())
                    },
                    timing,
                },
                contributions,
                folders,
                project_keys: Arc::new(PathKeys),
                clock: clock.clone(),
                bus: bus.clone(),
                jobs: kernel.jobs.clone(),
            })
            .unwrap(),
        );
        module.start().await.unwrap();
        let heard = {
            let rang = rang.clone();
            bus.on(Filter::All, move |_| rang.notify_waiters())
        };
        let sync = module.service();
        Self { home, clock, kernel, profile, memories, pages, module, sync, rang: rang.clone(), _heard: heard }
    }
}

/// Waits until `ok` holds, looking again whenever any computer announces
/// something. Panics after ten seconds without it.
pub(crate) async fn until(rang: &Notify, what: &str, ok: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let heard = rang.notified();
        tokio::pin!(heard);
        heard.as_mut().enable();
        if ok() {
            return;
        }
        if tokio::time::timeout_at(deadline, heard).await.is_err() {
            assert!(ok(), "timed out waiting for {what}");
            return;
        }
    }
}
