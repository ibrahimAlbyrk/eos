//! Needs-you hand-offs: a run from a trigger of a routine at Ask waits on a
//! `run_start` item until the user answers it, and the routines act once on
//! each answer to their items: a run started or skipped, a change confirmed,
//! a late answer told to the run's lead.

use std::sync::Arc;

use eos_contracts::{InboxChange, RoutineState, VersionAuthor, VersionStatus};
use eos_core::routine::RunOrigin;
use eos_core::store::{ItemAnswer, StoredItem, StoredVersion};
use eos_core::{Clock, Ids};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::blueprint::{Readable, canonical_json, hash, read};
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_domain::run_scope::Trust;
use eos_inbox::{NewItem, Opening, open_in};
use eos_testkit::FakeTimeZone;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint, new_run, pull_request};

fn asking() -> Value {
    let mut asking = blueprint(2);
    asking["freedom"] = json!({"rung": "ask"});
    asking
}

impl Bench {
    /// A run an agent starts: not the user, so it is asked about.
    async fn triggered(&self, routine: &str, number: u32) -> String {
        let agent = RunOrigin::Agent { worker_id: "w-chat".into() };
        self.start(new_run(routine, agent, Some(pull_request(number)))).await.expect("starts").remove(0).id
    }

    fn items_of(&self, routine: &str, kind: ItemKind) -> Vec<StoredItem> {
        let id = routine.to_owned();
        let items = self.temp.store.read_blocking(move |tx| tx.inbox_items().waiting_of_routine(&id));
        items.expect("reads").into_iter().filter(|item| item.kind == kind).collect()
    }

    fn item(&self, id: &str) -> StoredItem {
        let id = id.to_owned();
        self.temp.store.read_blocking(move |tx| tx.inbox_items().find(&id)).expect("reads").expect("the item")
    }

    /// Answers `item` as the answering job does, announcing it.
    fn answer(&self, item: &StoredItem, by: &str, answer: Value) {
        let (id, rev, at) = (item.id.clone(), item.rev, self.clock.now_ms());
        let (kind, routine_id) = (item.kind.as_str().to_owned(), item.routine_id.clone());
        let answer = ItemAnswer { by: by.into(), answer: Some(answer.to_string()), at };
        let done = self.temp.store.write_blocking(move |tx, out| {
            let done = tx.inbox_items().answer(&id, rev, &answer)?;
            let change = InboxChange { id, kind, state: "answered".into(), routine_id, rev: rev + 1, open: 0 };
            out.push("inbox:change", &change);
            Ok(done)
        });
        assert!(done.expect("answers"));
    }

    fn open(&self, new: NewItem) -> StoredItem {
        let (control, now) = (self.module.control(), self.clock.now_ms());
        let (ids, zone) = (self.ids.clone(), Arc::new(FakeTimeZone::new("Europe/Istanbul", 180)));
        let open = move |tx: &dyn eos_core::store::Tx, out: &mut eos_core::store::Outbox| {
            let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
            open_in(tx, out, &at, new)
        };
        self.temp.store.write_blocking(open).expect("opens")
    }

    fn versions(&self, routine: &str) -> Vec<StoredVersion> {
        let id = routine.to_owned();
        self.temp.store.read_blocking(move |tx| tx.routine_versions().list(&id)).expect("reads")
    }
}

fn item_of(kind: ItemKind, routine: &str, run: Option<&str>, payload: Value) -> NewItem {
    NewItem {
        kind,
        producer: "routines".into(),
        routine_id: Some(routine.to_owned()),
        run_id: run.map(str::to_owned),
        subject_key: None,
        title: "t".into(),
        summary: "s".into(),
        payload,
        by_hand: false,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_triggered_run_at_ask_waits_for_run_and_a_hand_run_never_asks() {
    let bench = Bench::new(true);
    let routine = bench.routine_with(RoutineState::Active, asking(), true);
    let waiting = bench.triggered(&routine, 483).await;
    bench.supervise().await;

    bench.eventually(|| bench.items_of(&routine, ItemKind::RunStart).len() == 1).await;
    let ask = bench.items_of(&routine, ItemKind::RunStart).remove(0);
    assert_eq!(ask.run_id.as_deref(), Some(waiting.as_str()));
    assert_eq!(ask.title, "PR Review: Fix the login. Run it?");
    let payload: Value = serde_json::from_str(&ask.payload).expect("json");
    assert_eq!(
        (payload["runId"].as_str(), payload["item"]["key"].as_str()),
        (Some(waiting.as_str()), Some("github:pr:acme/game#483"))
    );
    assert_eq!(bench.state(&waiting), RunState::Queued);

    let by_hand = bench.hand(&routine, Some(pull_request(484))).await;
    bench.eventually(|| bench.run(&by_hand).station == Some(Station::Work)).await;
    assert_eq!(bench.items_of(&routine, ItemKind::RunStart).len(), 1, "starting it was the yes");
    assert_eq!(bench.state(&waiting), RunState::Queued, "still waits for the user");

    bench.answer(&ask, "dashboard", json!({"kind": "run_start", "choice": "run"}));
    bench.eventually(|| bench.state(&waiting) == RunState::Running).await;
    bench.eventually(|| bench.item(&ask.id).consumed_at.is_some()).await;
    assert_eq!(bench.items_of(&routine, ItemKind::RunStart).len(), 0, "asked once");
}

#[tokio::test(flavor = "multi_thread")]
async fn skip_skips_the_run_and_an_expired_start_skips_it_as_too_late() {
    let bench = Bench::new(true);
    let routine = bench.routine_with(RoutineState::Active, asking(), true);
    let skipped = bench.triggered(&routine, 1).await;
    let expired = bench.triggered(&routine, 2).await;
    bench.supervise().await;
    bench.eventually(|| bench.items_of(&routine, ItemKind::RunStart).len() == 2).await;
    let asks = bench.items_of(&routine, ItemKind::RunStart);
    let ask_of = |run: &str| asks.iter().find(|item| item.run_id.as_deref() == Some(run)).expect("asked").clone();

    bench.answer(&ask_of(&skipped), "phone", json!({"kind": "run_start", "choice": "skip"}));
    bench.answer(&ask_of(&expired), "system", json!({"expired": true}));
    bench.eventually(|| bench.state(&skipped) == RunState::Skipped && bench.state(&expired) == RunState::Skipped).await;
    assert_eq!(bench.run(&skipped).reason, Some(Reason::User));
    assert_eq!(bench.run(&expired).reason, Some(Reason::TooLate));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_confirmed_change_is_kept_as_the_user_s_once() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let mut bolder = blueprint(1);
    bolder["freedom"] = json!({"rung": "send_then_tell"});
    let Ok(Readable::Current(typed)) = read(&bolder) else { panic!("a blueprint of this app") };
    let text = canonical_json(&typed);
    let proposed = StoredVersion {
        id: bench.ids.routine_version_id(),
        routine_id: routine.clone(),
        parent_id: None,
        status: VersionStatus::Draft,
        author: VersionAuthor::Architect,
        note: None,
        format: 1,
        hash: hash(&text),
        blueprint: text,
        no_trial: false,
        trust: Trust::Trusted,
        device: None,
        created_at: 2,
    };
    let insert = proposed.clone();
    bench.temp.store.write_blocking(move |tx, _| tx.routine_versions().insert(&insert)).expect("writes");
    bench.supervise().await;
    let confirm = bench.open(item_of(ItemKind::ConfirmChange, &routine, None, json!({"versionId": proposed.id})));

    bench.answer(&confirm, "dashboard", json!({"kind": "confirm_change", "choice": "confirm"}));
    bench.eventually(|| bench.item(&confirm.id).consumed_at.is_some()).await;
    let versions = bench.versions(&routine);
    assert_eq!(versions.len(), 3);
    let kept = versions.last().expect("a new version");
    assert_eq!((kept.status, kept.author, &kept.hash), (VersionStatus::Kept, VersionAuthor::User, &proposed.hash));
    let confirmed = bench.module.control().confirmed(&routine).await.expect("confirmed");
    assert_eq!(confirmed.freedom.rung, eos_contracts::Rung::SendThenTell);

    // The event again: the answer was acted on already.
    let again = bench.item(&confirm.id);
    bench
        .temp
        .store
        .write_blocking(move |_, out| {
            let change = InboxChange {
                id: again.id,
                kind: "confirm_change".into(),
                state: "answered".into(),
                routine_id: again.routine_id,
                rev: again.rev,
                open: 0,
            };
            out.push("inbox:change", &change);
            Ok(())
        })
        .expect("announces");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(bench.versions(&routine).len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_answer_whose_asker_is_gone_reaches_the_lead_as_a_note() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    bench.supervise().await;
    let run = bench.hand(&routine, Some(pull_request(9))).await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    let question = bench.open(item_of(ItemKind::Question, &routine, Some(&run), json!({"questions": []})));

    let answers = json!({"kind": "question", "answers": {"Which branch?": "main"}});
    bench.answer(&question, "dashboard", answers);
    bench.eventually(|| bench.item(&question.id).consumed_at.is_some()).await;
    let sent = bench.agents.sent(&lead);
    let notes: Vec<&String> = sent.iter().filter(|text| text.contains("Q: Which branch?\nA: main")).collect();
    assert_eq!(notes.len(), 1, "{sent:?}");
    assert!(notes[0].starts_with(&format!("<system_message kind=\"routine_note\" run-id=\"{run}\"")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_waiting_start_is_withdrawn_when_its_run_leaves_the_queue_without_it() {
    let bench = Bench::new(true);
    let routine = bench.routine_with(RoutineState::Active, asking(), true);
    let waiting = bench.triggered(&routine, 7).await;
    bench.supervise().await;
    bench.eventually(|| bench.items_of(&routine, ItemKind::RunStart).len() == 1).await;
    let ask = bench.items_of(&routine, ItemKind::RunStart).remove(0);

    bench.module.control().pause(&routine, "user").await.expect("paused");
    assert_eq!(bench.state(&waiting), RunState::Skipped);
    assert_eq!(bench.item(&ask.id).state, eos_domain::inbox::ItemState::Withdrawn, "no answer can act on it");
}
