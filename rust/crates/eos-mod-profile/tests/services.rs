//! The profile and memory write paths: what
//! `core/src/__tests__/user-{memory,profile}-service.test.ts`,
//! `sync-write-paths.test.ts` and `memory-suggest-notify.ts` pin, plus what
//! Node's single thread gave for free (one save wins a race).

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{
    AvatarExt, DreamProposalKind, Num, UserMemory, UserMemoryCategory, UserMemoryChangeEvent,
    UserMemoryChangeEventAction as Action, UserMemoryChangeEventBy as By, UserMemoryDomain, UserMemoryId,
    UserMemoryProposal, UserMemoryScope, UserMemoryScopeProject, UserMemorySource, UserMemorySourceAgent,
    UserMemorySourceDream, UserMemoryStatus, UserMemorySuggestRequest, UserMemorySuggestRequestScope, UserMemoryTier,
    UserProfilePatch, UserProfilePatchDreaming, UserProfilePatchIdentity, UserProfilePatchSharing,
};
use eos_core::Error as CoreError;
use eos_core::profile::{SyncedIdentity, SyncedProfileFields, UserMemorySuggestion, UserMemorySync, UserProfileSync};
use eos_core::store::{UserAvatarStore, UserMemoryStore, UserProfileStore};
use eos_mod_profile::{
    Error, MEMORY_NOTIFY_DELAY, MemoryInput, MemoryPatch, PROFILE_CHANGE, PendingCaps, PreviewContext, ProfileModule,
    ProfileStores, USER_MEMORY_CHANGE, UserMemoryService, UserProfileService,
};
use eos_profile::ProfileBlocks;
use eos_runtime::bus::{Bus, EventReceiver};
use eos_runtime::module::Module;
use eos_runtime::{Kernel, KernelOptions};
use eos_testkit::{
    FakeClock, FakeMemoryProvider, FakeUserAvatarStore, FakeUserMemoryStore, FakeUserProfileStore, SeqIds, TempStore,
};

const JPEG: [u8; 4] = [0xff, 0xd8, 0xff, 0xe0];

fn agent(id: &str, name: &str) -> UserMemorySource {
    UserMemorySource::Agent(UserMemorySourceAgent { agent_id: id.into(), agent_name: name.into(), why: None })
}

fn dream(id: &str) -> UserMemorySource {
    UserMemorySource::Dream(UserMemorySourceDream { dream_id: id.into(), evidence: Vec::new(), why: None })
}

fn project(path: &str) -> UserMemoryScope {
    UserMemoryScope::Project(UserMemoryScopeProject { path: path.into() })
}

fn idea(text: &str) -> UserMemorySuggestion {
    UserMemorySuggestion {
        text: text.into(),
        category: UserMemoryCategory::Other,
        domain: None,
        scope: UserMemoryScope::Global,
        proposal: None,
    }
}

fn proposal(text: &str, kind: DreamProposalKind, targets: &[&UserMemoryId]) -> UserMemorySuggestion {
    let proposal = UserMemoryProposal {
        kind,
        targets: targets.iter().map(|id| (*id).clone()).collect(),
        confidence: Some(3),
        support: None,
    };
    UserMemorySuggestion { category: UserMemoryCategory::WorkStyle, proposal: Some(proposal), ..idea(text) }
}

fn input(text: &str, scope: UserMemoryScope, tier: UserMemoryTier) -> MemoryInput {
    MemoryInput { text: text.into(), category: UserMemoryCategory::WorkStyle, domain: None, scope, tier }
}

struct Memories {
    service: Arc<UserMemoryService>,
    store: Arc<FakeUserMemoryStore>,
    bus: Bus,
    events: EventReceiver,
}

fn memories(caps: PendingCaps) -> Memories {
    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
    let store = Arc::new(FakeUserMemoryStore::default());
    let events = kernel.bus.subscribe(&USER_MEMORY_CHANGE, 256);
    let service = Arc::new(UserMemoryService::new(store.clone(), clock, ids, kernel.bus.clone(), caps));
    Memories { service, store, bus: kernel.bus, events }
}

impl Memories {
    fn kept(&self, text: &str) -> Arc<UserMemory> {
        self.service.create(input(text, UserMemoryScope::Global, UserMemoryTier::Always)).expect("created")
    }

    /// Everything announced so far, as `(id, action, status, by)`.
    async fn announced(&mut self) -> Vec<(String, Action, UserMemoryStatus, By)> {
        self.bus.flush().await;
        let mut seen = Vec::new();
        while let Ok(Ok(event)) = tokio::time::timeout(Duration::from_millis(20), self.events.recv()).await {
            let change: UserMemoryChangeEvent = event.payload_as().expect("a memory change");
            seen.push((change.id.0, change.action, change.status, change.by));
        }
        seen
    }
}

#[tokio::test]
async fn an_agents_suggestion_waits_for_the_user_always_on_by_default() {
    let mut m = memories(PendingCaps::default());
    let suggestion = UserMemorySuggestion { category: UserMemoryCategory::Stack, ..idea("  Prefers   pnpm. ") };
    let result = m.service.suggest(suggestion, agent("w-1", "find-bar")).expect("suggested");
    assert!(!result.duplicate && !result.declined);
    let memory = result.memory;
    assert_eq!((memory.status, memory.tier, memory.rev), (UserMemoryStatus::Suggested, UserMemoryTier::Always, 0));
    assert_eq!(memory.text, "Prefers pnpm.");
    assert!(memory.id.0.starts_with("um-") && memory.id.0.len() == 15, "{}", memory.id.0);
    assert_eq!(m.announced().await, [(memory.id.0.clone(), Action::Created, UserMemoryStatus::Suggested, By::Agent)]);
}

#[tokio::test]
async fn a_duplicate_returns_the_existing_memory_instead_of_piling_up() {
    let m = memories(PendingCaps::default());
    let kept = m.kept("Write commits in English.");
    let again = UserMemorySuggestion { scope: project("/x"), ..idea("write commits in english") };
    let result = m.service.suggest(again, agent("w-1", "find-bar")).expect("answered");
    assert!(result.duplicate && !result.declined);
    assert_eq!(result.memory.id, kept.id);
    assert_eq!(m.store.list().len(), 1);
}

#[tokio::test]
async fn pending_suggestions_are_capped_per_producer_and_all_dreams_share_one_cap() {
    let m = memories(PendingCaps { per_producer: 2, dreams: 4 });
    let (one, other) = (agent("w-1", "find-bar"), agent("w-2", "stream"));
    m.service.suggest(idea("alpha beta"), one.clone()).expect("first");
    m.service.suggest(idea("gamma delta"), one.clone()).expect("second");
    let full = m.service.suggest(idea("epsilon zeta"), one).expect_err("capped");
    assert_eq!(full, CoreError::LimitExceeded("2 suggestions are already waiting for the user's review".into()));
    m.service.suggest(idea("eta theta"), other).expect("another agent has its own share");

    for i in 0..4 {
        let text = format!("distinct idea number {i} about {}", "xyz".repeat(i + 1));
        m.service.suggest(idea(&text), dream(&format!("dr-{i}"))).expect("a dream's");
    }
    let ninth = idea("distinct idea number 9 about something else entirely");
    assert!(matches!(m.service.suggest(ninth, dream("dr-other-mac")), Err(CoreError::LimitExceeded(_))));
    let waiting = m.store.list().iter().filter(|x| x.status == UserMemoryStatus::Suggested).count();
    assert_eq!(waiting, 3 + 4);
}

#[tokio::test]
async fn approve_keeps_it_and_dismiss_leaves_a_tombstone() {
    let mut m = memories(PendingCaps::default());
    let a = m.service.suggest(idea("one two"), agent("w-1", "a")).expect("a").memory;
    let b = m.service.suggest(idea("three four"), agent("w-1", "a")).expect("b").memory;
    let kept = m.service.approve(&a.id.0).expect("approved").expect("a memory");
    assert_eq!((kept.status, kept.rev), (UserMemoryStatus::Active, 1));
    assert_eq!(m.service.approve(&a.id.0).expect("again").expect("a memory").rev, 1, "keeping twice changes nothing");
    m.service.dismiss(&b.id.0).expect("dismissed");
    assert_eq!(m.store.get(&b.id.0).expect("still stored").status, UserMemoryStatus::Dismissed);
    let refused = m.service.dismiss(&a.id.0).expect_err("kept already");
    assert_eq!(refused, CoreError::Validation(format!("memory {} is not waiting for review", a.id.0)));
    let dismissed = m.service.approve(&b.id.0).expect_err("dismissed");
    assert_eq!(dismissed, CoreError::Validation(format!("memory {} was dismissed", b.id.0)));
    let seen = m.announced().await;
    assert_eq!(
        seen.iter().map(|e| e.1).collect::<Vec<_>>(),
        [Action::Created, Action::Created, Action::Approved, Action::Dismissed]
    );
    assert_eq!(seen[3], (b.id.0.clone(), Action::Dismissed, UserMemoryStatus::Dismissed, By::User));
}

#[tokio::test]
async fn a_dismissed_idea_is_declined_by_agents_and_dreams_alike() {
    let m = memories(PendingCaps::default());
    let first = m.service.suggest(idea("Prefers tabs over spaces."), agent("w-1", "a")).expect("suggested").memory;
    m.service.dismiss(&first.id.0).expect("dismissed");
    let again = m.service.suggest(idea("prefers tabs over spaces"), dream("dr-1")).expect("answered");
    assert!(again.duplicate && again.declined);
    assert_eq!(again.memory.id, first.id);
    assert!(m.service.search("tabs", None, 5).is_empty());
}

#[tokio::test]
async fn approve_all_keeps_every_pending_suggestion_that_still_applies() {
    let m = memories(PendingCaps::default());
    m.service.suggest(idea("one two"), agent("w-1", "a")).expect("a");
    m.service.suggest(idea("three four"), agent("w-2", "b")).expect("b");
    let target = m.kept("Something kept here.");
    let update = proposal("Something kept here, updated text.", DreamProposalKind::Update, &[&target.id]);
    let orphan = m.service.suggest(update, dream("dr-1")).expect("filed").memory;
    m.service.remove(&target.id.0).expect("removed");

    assert!(matches!(m.service.approve(&orphan.id.0), Err(CoreError::Conflict(_))));
    assert_eq!(m.service.approve_all().expect("kept").len(), 2, "the orphan is skipped, not an error");
    let left: Vec<_> =
        m.store.list().iter().filter(|x| x.status == UserMemoryStatus::Suggested).map(|x| x.id.clone()).collect();
    assert_eq!(left, std::slice::from_ref(&orphan.id));
}

#[tokio::test]
async fn update_refuses_a_stale_revision_keeps_the_rev_on_a_no_op_and_normalizes_text() {
    let m = memories(PendingCaps::default());
    let memory = m.kept("Use tabs.");
    let id = memory.id.0.as_str();
    let patch = MemoryPatch {
        text: Some("  Use   spaces. ".into()),
        tier: Some(UserMemoryTier::OnDemand),
        ..MemoryPatch::default()
    };
    let next = m.service.update(id, patch, Some(0)).expect("updated");
    assert_eq!((next.text.as_str(), next.rev, next.tier), ("Use spaces.", 1, UserMemoryTier::OnDemand));
    let same = MemoryPatch { tier: Some(UserMemoryTier::OnDemand), ..MemoryPatch::default() };
    assert_eq!(m.service.update(id, same, None).expect("no-op").rev, 1);
    let stale = m.service.update(id, MemoryPatch { text: Some("x".into()), ..MemoryPatch::default() }, Some(0));
    let Err(Error::StaleMemory(current)) = &stale else { panic!("{stale:?}") };
    assert_eq!(current.rev, 1);
    assert_eq!(
        stale.expect_err("stale").to_string(),
        format!("memory {id} changed since the revision you edited (now rev 1)")
    );
}

#[tokio::test]
async fn unknown_ids_are_not_found() {
    let m = memories(PendingCaps::default());
    assert_eq!(m.service.approve("um-nope0000").expect_err("unknown").to_string(), "memory not found: um-nope0000");
    assert!(matches!(m.service.remove("um-nope0000"), Err(CoreError::NotFound { .. })));
    assert!(matches!(m.service.dismiss("um-nope0000"), Err(CoreError::NotFound { .. })));
}

#[tokio::test]
async fn a_domain_is_stored_when_given_and_carried_by_an_update_proposal() {
    let m = memories(PendingCaps::default());
    let target = m.kept("When committing, split changes.");
    assert_eq!(target.domain, None);
    let update = UserMemorySuggestion {
        domain: Some(UserMemoryDomain::Git),
        ..proposal("When committing, review the diff and split changes.", DreamProposalKind::Update, &[&target.id])
    };
    let filed = m.service.suggest(update, dream("dr-1")).expect("filed").memory;
    m.service.approve(&filed.id.0).expect("kept");
    assert_eq!(m.store.get(&target.id.0).expect("target").domain, Some(UserMemoryDomain::Git));
}

#[tokio::test]
async fn an_update_proposal_rewrites_its_target_and_is_spent() {
    let mut m = memories(PendingCaps::default());
    let target = m.kept("Verify with lint and tests.");
    let unchanged = proposal("verify with lint and tests", DreamProposalKind::Update, &[&target.id]);
    let same = m.service.suggest(unchanged, dream("dr-1")).expect("answered");
    assert!(same.duplicate && same.memory.id == target.id, "an update that changes nothing is its target");

    let update = proposal("Verify with lint and tests; never restart Eos.", DreamProposalKind::Update, &[&target.id]);
    let filed = m.service.suggest(update, dream("dr-1")).expect("filed").memory;
    let out = m.service.approve(&filed.id.0).expect("kept").expect("the target");
    assert_eq!((out.id.clone(), out.rev), (target.id.clone(), 1));
    assert_eq!(m.store.get(&target.id.0).expect("target").text, "Verify with lint and tests; never restart Eos.");
    assert!(m.store.get(&filed.id.0).is_none());
    let seen = m.announced().await;
    assert_eq!(
        seen[seen.len() - 2..],
        [
            (filed.id.0.clone(), Action::Approved, UserMemoryStatus::Suggested, By::User),
            (target.id.0.clone(), Action::Updated, UserMemoryStatus::Active, By::User),
        ]
    );
}

#[tokio::test]
async fn merge_keeps_the_merged_text_and_removes_the_parts() {
    let m = memories(PendingCaps::default());
    let (a, b) = (m.kept("Chat in Turkish."), m.kept("Commits in English."));
    let merge = proposal("Chat in Turkish; ship everything in English.", DreamProposalKind::Merge, &[&a.id, &b.id]);
    let filed = m.service.suggest(merge, dream("dr-1")).expect("filed").memory;
    let kept = m.service.approve(&filed.id.0).expect("kept").expect("the merged memory");
    assert_eq!((kept.status, kept.proposal.clone()), (UserMemoryStatus::Active, None));
    assert!(m.store.get(&a.id.0).is_none() && m.store.get(&b.id.0).is_none());
    assert_eq!(m.store.get(&filed.id.0).expect("merged").proposal, None);
}

#[tokio::test]
async fn promote_makes_a_project_memory_global_and_retire_removes_one() {
    let m = memories(PendingCaps::default());
    let scoped =
        m.service.create(input("Keep diffs surgical.", project("/eos"), UserMemoryTier::Always)).expect("created");
    let promote = proposal("Keep diffs surgical.", DreamProposalKind::Promote, &[&scoped.id]);
    let filed = m.service.suggest(promote, dream("dr-1")).expect("filed").memory;
    m.service.approve(&filed.id.0).expect("kept");
    assert_eq!(m.store.get(&scoped.id.0).expect("promoted").scope, UserMemoryScope::Global);

    let old = m.kept("claude-cli is the fallback lane.");
    let retire = proposal("Removed in 368cc14f.", DreamProposalKind::Retire, &[&old.id]);
    let filed = m.service.suggest(retire, dream("dr-1")).expect("filed").memory;
    assert_eq!(m.service.approve(&filed.id.0).expect("kept"), None);
    assert!(m.store.get(&old.id.0).is_none() && m.store.get(&filed.id.0).is_none());
}

#[tokio::test]
async fn a_proposal_whose_target_is_gone_cannot_be_filed() {
    let m = memories(PendingCaps::default());
    let gone = UserMemoryId("um-gone0000".into());
    let refused = m.service.suggest(proposal("x y z", DreamProposalKind::Retire, &[&gone]), dream("dr-1"));
    assert_eq!(refused.expect_err("gone"), CoreError::Conflict("the memory this changes is gone (um-gone0000)".into()));
}

#[tokio::test]
async fn search_sees_only_kept_memories_in_scope() {
    let m = memories(PendingCaps::default());
    m.service.create(input("Prefers pnpm.", UserMemoryScope::Global, UserMemoryTier::OnDemand)).expect("created");
    m.service.suggest(idea("Pending pnpm thing."), agent("w-1", "a")).expect("suggested");
    let found: Vec<String> = m.service.search("pnpm", None, 5).iter().map(|x| x.text.clone()).collect();
    assert_eq!(found, ["Prefers pnpm."]);
}

#[tokio::test]
async fn a_synced_memory_is_stored_as_given_with_this_computers_rev_and_announced_as_sync() {
    let mut m = memories(PendingCaps::default());
    let sync: Arc<dyn UserMemorySync> = m.service.clone();
    let incoming = |text: &str| UserMemory {
        id: UserMemoryId("um-abcdef123456".into()),
        text: text.into(),
        category: UserMemoryCategory::Stack,
        domain: None,
        scope: UserMemoryScope::Global,
        tier: UserMemoryTier::Always,
        status: UserMemoryStatus::Suggested,
        source: dream("dr-1"),
        proposal: None,
        rev: 99,
        created_at: Num(10.0),
        updated_at: Num(20.0),
    };
    assert_eq!(sync.apply_synced(incoming("Prefers pnpm")).expect("applied").rev, 0);
    assert_eq!(sync.apply_synced(incoming("Prefers pnpm only")).expect("applied").rev, 1);
    assert_eq!(m.store.get("um-abcdef123456").expect("stored").updated_at, Num(20.0));
    sync.remove_synced("um-abcdef123456").expect("removed");
    sync.remove_synced("um-abcdef123456").expect("already gone is fine");
    let id = "um-abcdef123456".to_owned();
    assert_eq!(
        m.announced().await,
        [
            (id.clone(), Action::Created, UserMemoryStatus::Suggested, By::Sync),
            (id.clone(), Action::Updated, UserMemoryStatus::Suggested, By::Sync),
            (id, Action::Deleted, UserMemoryStatus::Suggested, By::Sync),
        ]
    );
}

#[test]
fn of_two_edits_from_one_revision_exactly_one_wins_and_a_burst_files_one_suggestion() {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("runtime");
    let _entered = runtime.enter();
    let m = memories(PendingCaps::default());
    let id = m.kept("Use tabs.").id.0.clone();
    for round in 0..20 {
        let edits: Vec<_> = (0..4)
            .map(|n| {
                let (service, id) = (m.service.clone(), id.clone());
                std::thread::spawn(move || {
                    let patch = MemoryPatch { text: Some(format!("round {round} by {n}")), ..MemoryPatch::default() };
                    service.update(&id, patch, Some(round)).is_ok()
                })
            })
            .collect();
        assert_eq!(edits.into_iter().map(|t| t.join().expect("edit")).filter(|won| *won).count(), 1, "round {round}");
    }
    let burst: Vec<_> = (0..8)
        .map(|_| {
            let service = m.service.clone();
            std::thread::spawn(move || {
                service.suggest(idea("Prefers pnpm over npm."), agent("w-1", "a")).expect("answered").duplicate
            })
        })
        .collect();
    assert_eq!(burst.into_iter().map(|t| t.join().expect("suggest")).filter(|duplicate| !duplicate).count(), 1);
}

// ---- profile ----------------------------------------------------------------

struct Profile {
    service: Arc<UserProfileService>,
    store: Arc<FakeUserProfileStore>,
    avatars: Arc<FakeUserAvatarStore>,
    bus: Bus,
    events: EventReceiver,
}

fn profile() -> Profile {
    let clock = Arc::new(FakeClock::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ..KernelOptions::default() });
    let (store, avatars) = (Arc::new(FakeUserProfileStore::default()), Arc::new(FakeUserAvatarStore::default()));
    let events = kernel.bus.subscribe(&PROFILE_CHANGE, 64);
    let service = Arc::new(UserProfileService::new(store.clone(), avatars.clone(), clock, kernel.bus.clone()));
    Profile { service, store, avatars, bus: kernel.bus, events }
}

impl Profile {
    async fn revs(&mut self) -> Vec<i64> {
        self.bus.flush().await;
        let mut seen = Vec::new();
        while let Ok(Ok(event)) = tokio::time::timeout(Duration::from_millis(20), self.events.recv()).await {
            seen.push(event.payload_as::<eos_contracts::UserProfileChangeEvent>().expect("a profile change").rev);
        }
        seen
    }
}

fn patch() -> UserProfilePatch {
    serde_json::from_str("{}").expect("an empty patch")
}

fn call_name(name: &str) -> UserProfilePatch {
    let identity = UserProfilePatchIdentity { full_name: None, call_name: Some(name.into()), handle: None };
    UserProfilePatch { identity: Some(identity), ..patch() }
}

fn instructions(text: &str) -> UserProfilePatch {
    UserProfilePatch { instructions: Some(text.into()), ..patch() }
}

#[tokio::test]
async fn the_profile_starts_empty_and_a_real_change_bumps_stamps_stores_and_announces() {
    let mut p = profile();
    assert_eq!(p.service.get().rev, 0);
    assert!(p.store.get().is_none(), "reading writes nothing");

    let saved = p.service.update(&call_name("Ibrahim"), None).expect("saved");
    assert_eq!((saved.rev, saved.updated_at), (1, Num::from(FakeClock::START_MS)));
    assert_eq!(p.store.get().expect("stored").identity.call_name, "Ibrahim");
    let again = p.service.update(&call_name(" Ibrahim "), None).expect("no-op");
    assert_eq!(again.rev, 1);
    assert_eq!(p.revs().await, [1], "a save that changes nothing announces nothing");
}

#[tokio::test]
async fn a_stale_base_revision_is_refused_with_the_current_profile() {
    let p = profile();
    p.service.update(&instructions("a"), Some(0)).expect("saved");
    let stale = p.service.update(&instructions("b"), Some(0)).expect_err("stale");
    let Error::StaleProfile(current) = &stale else { panic!("{stale:?}") };
    assert_eq!((current.rev, current.instructions.as_str()), (1, "a"));
    assert_eq!(stale.to_string(), "profile changed since the revision you edited (now rev 1)");
}

#[tokio::test]
async fn the_avatars_type_is_read_from_its_bytes() {
    let mut p = profile();
    let not_an_image = p.service.set_avatar(b"<svg/>").expect_err("not an image");
    assert_eq!(not_an_image, CoreError::Validation("avatar must be a PNG, JPEG or WebP image".into()));
    assert_eq!(p.service.set_avatar(&[]).expect_err("empty"), CoreError::Validation("empty image".into()));
    let mut huge = JPEG.to_vec();
    huge.resize(5 * 1024 * 1024 + 1, 0);
    assert_eq!(
        p.service.set_avatar(&huge).expect_err("too large"),
        CoreError::Validation("image larger than 5 MB".into())
    );

    let saved = p.service.set_avatar(&JPEG).expect("saved");
    assert_eq!(saved.identity.avatar, Some(AvatarExt::Jpeg));
    assert_eq!(p.avatars.read().expect("read").expect("an avatar").ext, AvatarExt::Jpeg);
    assert_eq!(p.service.clear_avatar().expect("cleared").identity.avatar, None);
    assert_eq!(p.avatars.read().expect("read"), None);
    assert_eq!(p.service.clear_avatar().expect("nothing to clear").rev, 2);
    assert_eq!(p.revs().await, [1, 2]);
}

#[tokio::test]
async fn synced_profile_fields_never_touch_this_computers_avatar_or_dreaming() {
    let p = profile();
    let dreaming: UserProfilePatchDreaming = serde_json::from_str(r#"{"enabled":true}"#).expect("a patch");
    p.service.update(&UserProfilePatch { dreaming: Some(dreaming), ..patch() }, None).expect("saved");
    p.service.set_avatar(&JPEG).expect("saved");
    let before = p.service.get().rev;

    let sync: Arc<dyn UserProfileSync> = p.service.clone();
    let identity = SyncedIdentity { full_name: "Ibrahim".into(), call_name: "ibrahim".into(), handle: String::new() };
    let fields =
        SyncedProfileFields { identity: Some(identity), budget_tokens: Some(1200), ..SyncedProfileFields::default() };
    let applied = sync.apply_synced(fields).expect("applied");
    assert_eq!(applied.identity.full_name, "Ibrahim");
    assert_eq!(applied.identity.avatar, Some(AvatarExt::Jpeg));
    assert!(applied.dreaming.enabled);
    assert_eq!(applied.rev, before + 1);
    let same = SyncedProfileFields { budget_tokens: Some(1200), ..SyncedProfileFields::default() };
    assert_eq!(sync.apply_synced(same).expect("no change").rev, before + 1, "no change, no new revision");
    assert!(sync.avatar().expect("read").is_some());
}

// ---- the module: agents, the notification, sync -----------------------------

struct Composed {
    module: ProfileModule,
    kernel: Kernel,
    profile: Arc<FakeUserProfileStore>,
    _temp: TempStore,
}

fn module() -> Composed {
    let temp = TempStore::seeded("/sandbox");
    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
    let (profile, memories) = (Arc::new(FakeUserProfileStore::default()), Arc::new(FakeUserMemoryStore::default()));
    let stores = ProfileStores {
        profile: profile.clone(),
        avatars: Arc::new(FakeUserAvatarStore::default()),
        memories: memories.clone(),
        workers: temp.port(),
    };
    let preview = PreviewContext {
        blocks: Arc::new(ProfileBlocks::new(profile.clone(), memories)),
        memory: Arc::new(FakeMemoryProvider::default()),
        data_home: temp.home.path().to_owned(),
        memory_injected: Arc::new(|| true),
        search_tool_name: "search_memory".into(),
    };
    let module = ProfileModule::new(stores, preview, PendingCaps::default(), clock, ids, kernel.bus.clone());
    Composed { module, kernel, profile, _temp: temp }
}

fn request(text: &str, scope: UserMemorySuggestRequestScope) -> UserMemorySuggestRequest {
    UserMemorySuggestRequest { text: text.into(), category: UserMemoryCategory::Stack, scope, why: None }
}

#[tokio::test]
async fn an_agent_suggests_into_its_own_project_and_searches_it() {
    let c = module();
    let (suggestions, search) = (c.module.memory_suggestions(), c.module.memory_search());
    use UserMemorySuggestRequestScope::{Global, Project};

    let filed =
        suggestions.suggest("w-CHAT", request("In this project, tests live in test/.", Project)).await.expect("filed");
    assert_eq!(filed.memory.scope, project("/sandbox/alpha"));
    let UserMemorySource::Agent(source) = &filed.memory.source else { panic!("{:?}", filed.memory.source) };
    assert_eq!((source.agent_id.as_str(), source.agent_name.as_str()), ("w-CHAT", "Fix the parser"));
    let nameless = suggestions.suggest("w-BARE", request("The user likes monads.", Global)).await.expect("filed");
    let UserMemorySource::Agent(source) = &nameless.memory.source else { panic!("{:?}", nameless.memory.source) };
    assert_eq!(source.agent_name, "w-BARE", "an agent with no name goes by its id");

    let no_folder = suggestions.suggest("w-BARE", request("No folder here.", Project)).await.expect_err("no folder");
    assert_eq!(no_folder, CoreError::Validation("this session has no project folder — suggest it as global".into()));
    let nobody = suggestions.suggest("w-nobody", request("x y", Global)).await.expect_err("not an agent");
    assert_eq!(nobody, CoreError::PermissionDenied("only an agent can suggest a memory".into()));
    let blank = suggestions.suggest("w-CHAT", request("", Global)).await.expect_err("blank");
    assert_eq!(blank.to_string(), "invalid request: text: String must contain at least 1 character(s)");

    // Kept, the project memory is found from inside the project only.
    let editor = c.module.memory_reader();
    assert!(search.search("w-CHAT", "tests", 5).await.expect("searched").is_empty(), "suggestions are not searchable");
    c.module.suggestion_sink().suggest(idea("unrelated dream idea words"), dream("dr-1")).expect("a dream files too");
    assert_eq!(editor.list().len(), 3);
}

#[tokio::test]
async fn a_backend_the_profile_is_withheld_from_can_neither_search_nor_suggest() {
    let c = module();
    // The seeded chats run on the `claude` backend kind.
    let sharing = UserProfilePatchSharing { withhold_from: Some(vec!["claude".into()]) };
    let mut withheld = eos_domain::user_profile::empty_user_profile();
    withheld.sharing.withhold_from = sharing.withhold_from.clone().unwrap_or_default();
    c.profile.put(withheld).expect("put");

    let refused = CoreError::PermissionDenied("the user doesn't share their profile with this provider".into());
    assert_eq!(c.module.memory_search().search("w-CHAT", "tabs", 5).await.expect_err("withheld"), refused);
    let suggestions = c.module.memory_suggestions();
    let suggest = suggestions.suggest("w-CHAT", request("x y", UserMemorySuggestRequestScope::Global));
    assert_eq!(suggest.await.expect_err("withheld"), refused);
}

// Time is the runtime's own and stands still until the test waits: nothing
// below yields between the suggestions, so the banner always counts all three.
#[tokio::test(start_paused = true)]
async fn a_burst_of_agent_suggestions_becomes_one_notification() {
    let c = module();
    c.module.start().await.expect("started");
    let mut fired = c.kernel.bus.subscribe("notification:fire", 8);
    let sink = c.module.suggestion_sink();
    let started = tokio::time::Instant::now();
    for text in ["The user prefers pnpm.", "When committing, split changes.", "Before pushing, run the linter."] {
        sink.suggest(idea(text), agent("w-CHAT", "Fix the parser")).expect("filed");
    }
    // A dream's proposal is announced by the dream itself.
    sink.suggest(idea("a dream noticed this other thing"), dream("dr-1")).expect("filed");

    let event = fired.recv().await.expect("the notification");
    assert!(started.elapsed() >= MEMORY_NOTIFY_DELAY, "not before the delay");
    let payload: serde_json::Value = event.payload_as().expect("json");
    assert_eq!(
        payload,
        serde_json::json!({
            "title": "Agents noticed 3 things",
            "body": "Review it before it's remembered.",
            "workerId": "",
            "route": "memory",
            "ts": FakeClock::START_MS,
        })
    );
    tokio::time::sleep(MEMORY_NOTIFY_DELAY * 2).await;
    c.kernel.bus.flush().await;
    assert!(tokio::time::timeout(Duration::from_millis(1), fired.recv()).await.is_err(), "one banner per burst");

    // Reviewed before the next banner is due: nothing left to announce.
    let late = sink.suggest(idea("one more thing noticed later"), agent("w-CHAT", "Fix the parser")).expect("filed");
    c.module.memory_sync().remove_synced(&late.memory.id.0).expect("removed");
    for waiting in c.module.memory_reader().list().iter().filter(|m| m.status == UserMemoryStatus::Suggested) {
        c.module.memory_sync().remove_synced(&waiting.id.0).expect("removed");
    }
    tokio::time::sleep(MEMORY_NOTIFY_DELAY * 2).await;
    c.kernel.bus.flush().await;
    assert!(tokio::time::timeout(Duration::from_millis(1), fired.recv()).await.is_err(), "nothing waits: no banner");
    c.module.stop().await;
}

#[tokio::test]
async fn the_sync_contributions_hand_over_the_write_paths() {
    let c = module();
    let contributions = c.module.sync();
    let domains: Vec<_> = contributions.iter().map(|s| (s.domain, s.change_topic)).collect();
    assert_eq!(
        domains,
        [("profile", Some("profile:change")), ("avatar", None), ("memory", Some("user-memory:change"))]
    );
    assert!(contributions[0].handle.clone().downcast::<Arc<dyn UserProfileSync>>().is_ok());
    assert!(contributions[1].handle.clone().downcast::<Arc<dyn UserProfileSync>>().is_ok());
    let memory = contributions[2].handle.clone().downcast::<Arc<dyn UserMemorySync>>().expect("the memory target");
    assert!(memory.list().is_empty());

    // A memory change sync applied is not a local edit; any other is.
    let is_local = contributions[2].is_local.clone().expect("a rule");
    let mut changes = c.kernel.bus.subscribe(&USER_MEMORY_CHANGE, 8);
    c.module.suggestion_sink().suggest(idea("made on this computer"), dream("dr-1")).expect("filed");
    let local = changes.recv().await.expect("an event");
    assert!(is_local(&local));
    let mut synced = eos_contracts::UserMemory::clone(&c.module.memory_reader().list()[0]);
    synced.id = UserMemoryId("um-fromelsewhere".into());
    memory.apply_synced(synced).expect("applied");
    assert!(!is_local(&changes.recv().await.expect("an event")));
}
