//! The page write path and what the tools and sync see of it, plus what
//! Node's single thread gave the 0.1.x app for free (one save wins a race) and the traits other features use.

use std::sync::Arc;
use std::time::Duration;

use eos_contracts::{
    Num, PageAuthor, PageAuthorKind, PageChangeEvent, PageChangeEventAction, PageEditRequest, PageEditRequestSetTask,
};
use eos_core::Error as CoreError;
use eos_core::pages::{PageSync, SyncedPage};
use eos_core::store::PageStore;
use eos_mod_pages::{Error, NewPage, PAGES_CHANGE, PageSave, PageService, PagesModule};
use eos_runtime::bus::{Bus, EventReceiver};
use eos_runtime::module::Module;
use eos_runtime::{Kernel, KernelOptions};
use eos_testkit::{FakeClock, FakePageStore, SeqIds, TempStore};

fn user() -> PageAuthor {
    PageAuthor { kind: PageAuthorKind::User, agent_id: None, name: None }
}

fn agent() -> PageAuthor {
    PageAuthor { kind: PageAuthorKind::Agent, agent_id: Some("w-1".into()), name: Some("Stance IK".into()) }
}

struct Fixture {
    service: Arc<PageService>,
    store: Arc<FakePageStore>,
    clock: Arc<FakeClock>,
    bus: Bus,
    events: EventReceiver,
}

fn fixture() -> Fixture {
    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
    let store = Arc::new(FakePageStore::default());
    let events = kernel.bus.subscribe(&PAGES_CHANGE, 64);
    let service = Arc::new(PageService::new(store.clone(), clock.clone(), ids, kernel.bus.clone()));
    Fixture { service, store, clock, bus: kernel.bus, events }
}

fn new(title: &str, body: &str, project: Option<&str>, agent_id: Option<&str>) -> NewPage {
    NewPage {
        title: title.into(),
        body: body.into(),
        project: project.map(str::to_owned),
        agent_id: agent_id.map(str::to_owned),
    }
}

async fn next(events: &mut EventReceiver) -> PageChangeEvent {
    let event = tokio::time::timeout(Duration::from_secs(5), events.recv()).await.expect("an event").expect("open");
    event.payload_as().expect("a page change")
}

async fn none_pending(f: &mut Fixture) {
    f.bus.flush().await;
    assert!(tokio::time::timeout(Duration::from_millis(20), f.events.recv()).await.is_err(), "no further event");
}

#[tokio::test]
async fn creates_lists_by_project_and_query_newest_first() {
    let mut f = fixture();
    let a = f.service.create(new(" A ", "alpha", Some("/p"), None), user()).expect("created");
    f.clock.advance(1);
    let b = f.service.create(new("B", "beta - [ ] x", Some("/q"), None), agent()).expect("created");
    assert_eq!((a.title.as_str(), a.rev), ("A", 1));
    assert!(a.id.0.starts_with("pg-0000000000"), "{}", a.id.0);
    let titles =
        |project, query| -> Vec<String> { f.service.list(project, query).into_iter().map(|p| p.title).collect() };
    assert_eq!(titles(Some("/p"), None), ["A"]);
    assert_eq!(titles(None, Some("BETA")), ["B"]);
    assert_eq!(titles(None, Some("  ")), ["B", "A"]);
    assert_eq!(titles(None, None), ["B", "A"]);
    let summary = &f.service.list(Some("/q"), None)[0];
    assert_eq!((summary.excerpt.as_str(), summary.tasks.open, summary.tasks.done), ("beta - [ ] x", 0, 0));

    let created = next(&mut f.events).await;
    assert_eq!((created.id.clone(), created.action, created.rev), (a.id.clone(), PageChangeEventAction::Created, 1));
    assert_eq!(created.project.as_deref(), Some("/p"));
    assert_eq!(next(&mut f.events).await.by, b.updated_by);
    none_pending(&mut f).await;
}

#[tokio::test]
async fn bumps_rev_on_change_skips_no_op_writes_and_refuses_a_stale_base_rev() {
    let mut f = fixture();
    let p = f.service.create(new("T", "one", None, None), user()).expect("created");
    let id = p.id.0.as_str();
    let save = |body: &str| PageSave { body: Some(body.into()), base_rev: Some(1), ..PageSave::default() };
    f.clock.advance(5);
    let same = f.service.save(id, save("one"), user()).expect("no-op");
    assert_eq!((same.rev, same.updated_at), (1, p.updated_at));
    let next_page = f.service.save(id, save("two"), agent()).expect("saved");
    assert_eq!((next_page.rev, next_page.updated_at), (2, Num::from(FakeClock::START_MS + 5)));
    assert_eq!(next_page.updated_by, agent());

    let stale = f.service.save(id, save("three"), user()).expect_err("stale");
    let Error::Stale(current) = &stale else { panic!("{stale:?}") };
    assert_eq!((current.rev, current.body.as_str()), (2, "two"));
    assert_eq!(stale.to_string(), format!("page {id} changed since the revision you edited (now rev 2)"));

    let retitled = f.service.save(id, PageSave { title: Some("  New  ".into()), ..PageSave::default() }, user());
    assert_eq!(retitled.expect("no base revision: last write wins").title, "New");
    assert!(matches!(f.service.save("pg-missing00", save("x"), user()), Err(Error::Core(CoreError::NotFound { .. }))));

    let actions: Vec<_> = [next(&mut f.events).await, next(&mut f.events).await, next(&mut f.events).await]
        .into_iter()
        .map(|e| (e.action, e.rev))
        .collect();
    use PageChangeEventAction::{Created, Updated};
    assert_eq!(actions, [(Created, 1), (Updated, 2), (Updated, 3)]);
    none_pending(&mut f).await;
}

#[tokio::test]
async fn applies_targeted_edits_to_the_latest_body_and_records_the_author() {
    let f = fixture();
    let p = f.service.create(new("T", "- [ ] a\n", None, None), user()).expect("created");
    let tick = |task: &str| PageEditRequest::SetTask(PageEditRequestSetTask { task: task.into(), done: true });
    let out = f.service.edit(&p.id.0, &tick("a"), agent()).expect("edited");
    assert_eq!((out.body.as_str(), out.rev), ("- [x] a\n", 2));
    assert_eq!(out.updated_by, agent());
    let refused = f.service.edit(&p.id.0, &tick("nothing like it"), agent()).expect_err("no such task");
    let Error::Core(CoreError::Validation(why)) = refused else { panic!("{refused:?}") };
    assert_eq!(why, "no checklist item matches \"nothing like it\"");
    assert_eq!(f.service.get(&p.id.0).expect("page").rev, 2);
}

#[tokio::test]
async fn removes_and_a_removed_chat_unlinks_its_pages() {
    let temp = TempStore::seeded("/sandbox");
    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
    let store = Arc::new(FakePageStore::default());
    let module = PagesModule::new(store.clone(), temp.port(), clock, ids, kernel.bus.clone());
    let subscribers = kernel.bus.subscriber_count();
    module.start().await.expect("started");
    assert_eq!(kernel.bus.subscriber_count(), subscribers + 1);
    let mut events = kernel.bus.subscribe(&PAGES_CHANGE, 16);

    let pages = module.editor();
    let linked = pages.create("w-KID1", "Findings", "one caller").await.expect("created");
    assert_eq!(linked.agent_id.as_deref(), Some("o-ORCH"), "linked to the chat's root");
    assert_eq!(linked.project.as_deref(), Some("/sandbox/alpha"));
    let other = pages.create("w-CHAT", "Other", "").await.expect("created");
    assert_eq!((next(&mut events).await.rev, next(&mut events).await.rev), (1, 1));

    kernel.bus.publish_raw("worker:removed", None, r#"{"workerId":"o-ORCH"}"#.into());
    let unlinked = next(&mut events).await;
    assert_eq!(
        (unlinked.id.clone(), unlinked.action, unlinked.rev),
        (linked.id.clone(), PageChangeEventAction::Updated, 2)
    );
    assert_eq!(unlinked.by, linked.updated_by, "the page's last author, not the remover");
    let stored = store.get(&linked.id.0).expect("still there");
    assert_eq!((stored.agent_id.as_deref(), stored.updated_at), (None, linked.updated_at));
    assert_eq!(store.get(&other.id.0).expect("page").agent_id.as_deref(), Some("w-CHAT"));

    module.stop().await;
    drop(events);
    assert_eq!(kernel.bus.subscriber_count(), subscribers, "the module's subscription ended with it");
}

#[tokio::test]
async fn an_agent_sees_its_projects_pages_and_edits_as_itself() {
    let temp = TempStore::seeded("/sandbox");
    let clock = Arc::new(FakeClock::new());
    let ids = Arc::new(SeqIds::new());
    let kernel = Kernel::new(KernelOptions { clock: clock.clone(), ids: ids.clone(), ..KernelOptions::default() });
    let module = PagesModule::new(Arc::new(FakePageStore::default()), temp.port(), clock.clone(), ids, kernel.bus);
    let pages = module.editor();

    let mine = pages.create("w-CHAT", " Plan ", "- [ ] ship").await.expect("created");
    assert_eq!((mine.title.as_str(), mine.agent_id.as_deref()), ("Plan", Some("w-CHAT")));
    assert_eq!(
        mine.updated_by,
        PageAuthor {
            kind: PageAuthorKind::Agent,
            agent_id: Some("w-CHAT".into()),
            name: Some("Fix the parser".into())
        }
    );
    clock.advance(1);
    // No folder, and an id that names no worker: filed under no project, as the user's own.
    let bare = pages.create("w-BARE", "Bare", "").await.expect("created");
    assert_eq!((bare.project.as_deref(), bare.agent_id.as_deref()), (None, Some("w-BARE")));
    let unknown = pages.create("w-nobody", "Unknown", "").await.expect("created");
    assert_eq!((unknown.updated_by.kind, unknown.agent_id.as_deref()), (PageAuthorKind::User, None));

    let titles = |pages: Vec<eos_contracts::PageSummary>| pages.into_iter().map(|p| p.title).collect::<Vec<_>>();
    assert_eq!(titles(pages.list("w-CHAT", None, false).await.expect("list")), ["Plan"]);
    assert_eq!(titles(pages.list("w-CHAT", None, true).await.expect("list")).len(), 3);
    assert_eq!(
        titles(pages.list("w-BARE", Some("ship"), false).await.expect("list")),
        ["Plan"],
        "no project: every page"
    );

    let tick = PageEditRequest::SetTask(PageEditRequestSetTask { task: "ship".into(), done: true });
    let edited = pages.edit("w-KID1", &mine.id.0, &tick).await.expect("edited");
    assert_eq!(edited.body, "- [x] ship");
    assert_eq!(edited.updated_by.agent_id.as_deref(), Some("w-KID1"));
    assert_eq!(pages.read(&mine.id.0).await.expect("read").rev, 2);

    let bad = pages.read("nope").await.expect_err("not an id");
    assert_eq!(bad, CoreError::Validation("invalid request: : invalid page id".into()));
    assert_eq!(pages.read("pg-00000000").await.expect_err("unknown").to_string(), "page not found: pg-00000000");
    let long = pages.create("w-CHAT", &"x".repeat(201), "").await.expect_err("too long");
    assert_eq!(long.to_string(), "invalid request: title: String must contain at most 200 character(s)");
}

#[tokio::test]
async fn sync_applies_a_page_as_given_and_keeps_this_computers_chat_link() {
    let mut f = fixture();
    let sync: Arc<dyn PageSync> = f.service.clone();
    let synced = |title: &str| SyncedPage {
        id: "pg-synced0001".into(),
        title: title.into(),
        body: "from the other Mac".into(),
        project: Some("/p".into()),
        created_at: Num(10.0),
        updated_at: Num(20.0),
        updated_by: agent(),
    };
    let first = sync.apply_synced(synced("One")).expect("applied");
    assert_eq!((first.rev, first.agent_id.as_deref(), first.updated_at), (1, None, Num(20.0)));
    assert_eq!(sync.list().len(), 1);

    // Linked to a chat here: the link survives the next version from elsewhere.
    f.store.put(eos_contracts::Page { agent_id: Some("w-9".into()), ..(*first).clone() }).expect("put");
    let second = sync.apply_synced(synced("Two")).expect("applied");
    assert_eq!((second.rev, second.agent_id.as_deref(), second.title.as_str()), (2, Some("w-9"), "Two"));

    sync.remove_synced("pg-synced0001").expect("removed");
    sync.remove_synced("pg-synced0001").expect("already gone is fine");
    assert!(sync.get("pg-synced0001").is_none());

    use PageChangeEventAction::{Created, Deleted, Updated};
    let seen = [next(&mut f.events).await, next(&mut f.events).await, next(&mut f.events).await];
    assert_eq!(seen.iter().map(|e| (e.action, e.rev)).collect::<Vec<_>>(), [(Created, 1), (Updated, 2), (Deleted, 2)]);
    assert!(seen.iter().all(|e| e.by == agent()), "attributed to the page's author");
    none_pending(&mut f).await;
}

#[tokio::test]
async fn the_sync_contribution_hands_over_the_page_write_path() {
    let temp = TempStore::new();
    let kernel = Kernel::new(KernelOptions::default());
    let module = PagesModule::new(
        Arc::new(FakePageStore::default()),
        temp.port(),
        Arc::new(FakeClock::new()),
        Arc::new(SeqIds::new()),
        kernel.bus,
    );
    let contributions = module.sync();
    assert_eq!(contributions.len(), 1);
    let page = &contributions[0];
    assert_eq!((page.domain, page.change_topic), ("page", Some("pages:change")));
    let target = page.handle.clone().downcast::<Arc<dyn PageSync>>().expect("an Arc<dyn PageSync>");
    assert!(target.list().is_empty());
    assert_eq!(module.plugin(), Some("eos.pages"));
}

#[test]
fn of_two_saves_from_one_revision_exactly_one_wins() {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("runtime");
    let _entered = runtime.enter();
    let f = fixture();
    let id = f.service.create(new("T", "base", None, None), user()).expect("created").id.0.clone();
    for round in 1..=20 {
        let savers: Vec<_> = (0..4)
            .map(|n| {
                let (service, id) = (f.service.clone(), id.clone());
                std::thread::spawn(move || {
                    let save = PageSave {
                        body: Some(format!("round {round} by {n}")),
                        base_rev: Some(round),
                        ..PageSave::default()
                    };
                    service.save(&id, save, user()).is_ok()
                })
            })
            .collect();
        let won = savers.into_iter().map(|t| t.join().expect("saver")).filter(|won| *won).count();
        assert_eq!(won, 1, "round {round}");
        assert_eq!(f.service.get(&id).expect("page").rev, round + 1);
    }
}
