//! The sync domains over the profile, memory and page services
//! (`manager/services/__tests__/user-sync-domains.test.ts`).

#![allow(clippy::unwrap_used)]

mod support;

use std::sync::Arc;

use eos_contracts::{PageAuthor, UserMemoryCategory, UserMemoryScope, UserMemoryScopeProject, UserMemoryTier};
use eos_core::net::sync::SyncDomain;
use eos_core::store::{PageStore, UserMemoryStore};
use eos_mod_pages::{NewPage, PageService};
use eos_mod_profile::{MemoryInput, PendingCaps, UserMemoryService, UserProfileService};
use eos_mod_sync::domains::{AvatarDomain, MemoryDomain, PageDomain, ProfileDomain};
use eos_runtime::{Kernel, KernelOptions};
use eos_testkit::{FakeClock, FakePageStore, FakeUserAvatarStore, FakeUserMemoryStore, FakeUserProfileStore, SeqIds};
use serde_json::{Value, json};
use support::RepoAt;

struct Bench {
    kernel: Kernel,
    clock: Arc<FakeClock>,
    ids: Arc<SeqIds>,
}

fn bench() -> Bench {
    let (clock, ids) = (Arc::new(FakeClock::at(1000)), Arc::new(SeqIds::new()));
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
    Bench { kernel, clock, ids }
}

fn profile_service(b: &Bench) -> Arc<UserProfileService> {
    Arc::new(UserProfileService::new(
        Arc::new(FakeUserProfileStore::default()),
        Arc::new(FakeUserAvatarStore::default()),
        b.clock.clone(),
        b.kernel.bus.clone(),
    ))
}

fn ids_of(items: &[eos_domain::sync::SyncItem]) -> Vec<&str> {
    let mut ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
    ids.sort_unstable();
    ids
}

#[tokio::test]
async fn profile_groups_at_their_defaults_are_absent_and_a_tombstone_resets_one() {
    let b = bench();
    let service = profile_service(&b);
    let domain = ProfileDomain::new(service.clone());
    assert!(domain.list().await.unwrap().is_empty());
    let patch =
        serde_json::from_value(json!({ "style": { "replies": "terse" }, "language": { "chat": "tr" } })).unwrap();
    service.update(&patch, None).unwrap();
    let listed = domain.list().await.unwrap();
    assert_eq!(ids_of(&listed), ["language", "style"]);
    // A group travels whole, as the TypeScript app writes it.
    let style = domain.get("style").await.unwrap().unwrap();
    assert_eq!(style.data, json!({ "replies": "terse", "autonomy": null, "whenUnclear": null, "commits": null }));
    assert_eq!(style.updated_at, Some(1000.0));
    assert_eq!(domain.get("language").await.unwrap().unwrap().data, json!({ "chat": "tr", "code": null }));
    assert!(domain.get("dreaming").await.unwrap().is_none());

    let other = profile_service(&b);
    let theirs = ProfileDomain::new(other.clone());
    theirs.apply("style", &style.data).await.unwrap();
    assert_eq!(serde_json::to_value(&other.get().style).unwrap()["replies"], "terse");
    assert!(theirs.apply("style", &json!({ "replies": "loud" })).await.is_err());
    assert!(theirs.apply("dreaming", &json!({})).await.is_err());
    theirs.remove("style").await.unwrap();
    assert_eq!(serde_json::to_value(&other.get().style).unwrap()["replies"], Value::Null);
    theirs.remove("dreaming").await.unwrap();
}

#[tokio::test]
async fn every_profile_group_travels_and_lands() {
    let b = bench();
    let (here, there) = (profile_service(&b), profile_service(&b));
    let patch = serde_json::from_value(json!({
        "identity": { "fullName": "Ada Lovelace", "callName": "Ada", "handle": "ada" },
        "language": { "chat": "en", "code": "mirror" },
        "work": { "roles": ["engineering"], "stack": ["rust"], "level": "expert" },
        "style": { "replies": "terse" },
        "instructions": "Be brief.",
        "sharing": { "withholdFrom": ["openai"] },
        "budgetTokens": 900,
        "onboardedAt": 5,
    }))
    .unwrap();
    here.update(&patch, None).unwrap();
    let (from, to) = (ProfileDomain::new(here.clone()), ProfileDomain::new(there.clone()));
    let items = from.list().await.unwrap();
    assert_eq!(items.len(), 8);
    assert_eq!(
        from.get("identity").await.unwrap().unwrap().data,
        json!({ "fullName": "Ada Lovelace", "callName": "Ada", "handle": "ada" })
    );
    for item in &items {
        to.apply(&item.id, &item.data).await.unwrap();
    }
    let (a, z) = (serde_json::to_value(&*here.get()).unwrap(), serde_json::to_value(&*there.get()).unwrap());
    for group in ["identity", "language", "work", "style", "instructions", "sharing", "budgetTokens", "onboardedAt"] {
        assert_eq!(a[group], z[group], "{group}");
    }
    // What landed reads back as what was sent: nothing to push back.
    for item in &items {
        assert_eq!(to.get(&item.id).await.unwrap().unwrap().data, item.data, "{}", item.id);
    }
}

#[tokio::test]
async fn the_avatar_travels_as_its_bytes() {
    // The smallest PNG header the service accepts as a picture.
    const PNG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let b = bench();
    let (here, there) = (profile_service(&b), profile_service(&b));
    let (from, to) = (AvatarDomain::new(here.clone()), AvatarDomain::new(there.clone()));
    assert!(from.list().await.unwrap().is_empty());
    here.set_avatar(&PNG).unwrap();
    let item = from.get("avatar").await.unwrap().unwrap();
    assert_eq!(item.data, json!({ "ext": "png", "b64": "iVBORw0KGgo=" }));
    to.apply("avatar", &item.data).await.unwrap();
    assert_eq!(there.avatar().unwrap().unwrap().bytes, PNG);
    assert!(to.apply("avatar", &json!({ "ext": "gif", "b64": "AAAA" })).await.is_err());
    assert!(to.apply("avatar", &json!({ "ext": "png", "b64": "" })).await.is_err());
    to.remove("avatar").await.unwrap();
    assert!(there.avatar().unwrap().is_none());
}

fn memory_service(b: &Bench, store: Arc<FakeUserMemoryStore>) -> Arc<UserMemoryService> {
    Arc::new(UserMemoryService::new(
        store,
        b.clock.clone(),
        b.ids.clone(),
        b.kernel.bus.clone(),
        PendingCaps::default(),
    ))
}

#[tokio::test]
async fn memories_travel_with_their_project_as_a_key_and_land_in_this_computers_folder() {
    let b = bench();
    let air = memory_service(&b, Arc::new(FakeUserMemoryStore::default()));
    let created = air
        .create(MemoryInput {
            text: "Use tabs here".into(),
            category: UserMemoryCategory::WorkStyle,
            domain: None,
            scope: UserMemoryScope::Project(UserMemoryScopeProject { path: "/air/eos".into() }),
            tier: UserMemoryTier::Always,
        })
        .unwrap();
    let item = MemoryDomain::new(air, Arc::new(RepoAt("/air/eos"))).get(&created.id.0).await.unwrap().unwrap();
    assert_eq!(
        item.data["scope"],
        json!({ "kind": "project", "project": { "key": "git:github.com/o/eos", "path": "/air/eos" } })
    );
    assert!(item.data.get("rev").is_none() && item.data.get("id").is_none());
    assert_eq!(item.updated_at, Some(1000.0));

    let pro_store = Arc::new(FakeUserMemoryStore::default());
    let pro = MemoryDomain::new(memory_service(&b, pro_store.clone()), Arc::new(RepoAt("/pro/eos")));
    pro.apply(&created.id.0, &item.data).await.unwrap();
    let landed = pro_store.get(&created.id.0).unwrap();
    assert_eq!(landed.scope, UserMemoryScope::Project(UserMemoryScopeProject { path: "/pro/eos".into() }));
    assert_eq!(landed.text, "Use tabs here");
    // Sent back, it is the same record: the key, not this computer's path.
    let back = pro.get(&created.id.0).await.unwrap().unwrap();
    assert_eq!(back.data["scope"]["project"]["key"], "git:github.com/o/eos");

    assert!(pro.apply("um-000000000009", &json!({ "text": "x" })).await.is_err(), "half a memory is refused");
    assert!(pro.apply("../evil", &item.data).await.is_err(), "so is an id that is not one");
    pro.remove(&created.id.0).await.unwrap();
    assert!(pro.get(&created.id.0).await.unwrap().is_none());
}

fn user() -> PageAuthor {
    serde_json::from_value(json!({ "kind": "user", "agentId": null, "name": null })).unwrap()
}

#[tokio::test]
async fn pages_keep_this_computers_chat_link_and_map_their_project() {
    let b = bench();
    let air_pages = Arc::new(PageService::new(
        Arc::new(FakePageStore::default()),
        b.clock.clone(),
        b.ids.clone(),
        b.kernel.bus.clone(),
    ));
    let page = air_pages
        .create(
            NewPage {
                title: "Plan".into(),
                body: "- [ ] x".into(),
                project: Some("/air/eos".into()),
                agent_id: Some("w-air".into()),
            },
            user(),
        )
        .unwrap();
    let item = PageDomain::new(air_pages, Arc::new(RepoAt("/air/eos"))).get(&page.id.0).await.unwrap().unwrap();
    assert!(item.data.get("agentId").is_none() && item.data.get("rev").is_none() && item.data.get("id").is_none());
    assert_eq!(item.data["project"], json!({ "key": "git:github.com/o/eos", "path": "/air/eos" }));
    assert_eq!(
        item.data.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["title", "body", "createdAt", "updatedAt", "updatedBy", "project"],
        "the portable page, field for field"
    );

    let pro_store = Arc::new(FakePageStore::default());
    let mut here = (*page).clone();
    here.project = Some("/pro/eos".into());
    here.agent_id = Some("w-pro".into());
    here.body = "old".into();
    pro_store.put(here).unwrap();
    let pro_pages = Arc::new(PageService::new(pro_store.clone(), b.clock.clone(), b.ids.clone(), b.kernel.bus.clone()));
    let pro = PageDomain::new(pro_pages, Arc::new(RepoAt("/pro/eos")));
    pro.apply(&page.id.0, &item.data).await.unwrap();
    let got = pro_store.get(&page.id.0).unwrap();
    assert_eq!(got.body, "- [ ] x");
    assert_eq!(got.agent_id.as_deref(), Some("w-pro"));
    assert_eq!(got.project.as_deref(), Some("/pro/eos"));

    assert!(pro.apply(&page.id.0, &json!({ "title": "t" })).await.is_err(), "half a page is refused");
    pro.remove(&page.id.0).await.unwrap();
    assert!(pro.get(&page.id.0).await.unwrap().is_none());
}
