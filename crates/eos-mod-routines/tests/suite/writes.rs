//! A routine's life by hand: its state with what it does to queued runs,
//! delete with its runs cancelled and items withdrawn in one write, undelete,
//! keeping a one-off, and who may call what.

use std::sync::Arc;

use eos_contracts::{RoutineKind, RoutineState, WorkerState};
use eos_core::Clock;
use eos_core::routine::RunOrigin;
use eos_core::store::StoredItem;
use eos_domain::inbox::{ItemKind, ItemState};
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_inbox::{NewItem, Opening, open_in};
use eos_runtime::access::{Caller, Tier};
use eos_runtime::http::Method;
use eos_testkit::{FakeTimeZone, SeqIds};
use serde_json::{Value, json};

use crate::bench::{HOUR, blueprint, new_run, pull_request};
use crate::run_routes::Routes;

impl Routes {
    async fn set_state(&self, routine: &str, state: &str) -> (u16, Value) {
        let path = format!("/api/routines/{routine}/state");
        self.call(Method::Put, Caller::DASHBOARD, &path, Some(json!({"state": state}))).await
    }

    /// A run queued for an hour from now.
    async fn queued(&self, routine: &str, origin: RunOrigin, number: u32) -> String {
        let bench = &self.bench;
        let mut later = new_run(routine, origin, Some(pull_request(number)));
        later.input.at = Some(bench.clock.now_ms() + HOUR);
        bench.start(later).await.expect("queued").remove(0).id
    }

    fn changes(&self) -> Vec<Value> {
        let announced = self.bench.temp.announced.list().into_iter().filter(|(topic, _)| *topic == "routine:change");
        announced.map(|(_, payload)| serde_json::from_str(&payload).expect("json")).collect()
    }

    fn routine_row(&self, routine: &str) -> eos_core::store::StoredRoutine {
        let id = routine.to_owned();
        self.bench.temp.store.read_blocking(move |tx| tx.routines().find(&id)).expect("reads").expect("a routine")
    }

    fn item(&self, routine: &str) -> StoredItem {
        let (ids, control, now) = (SeqIds::new(), self.bench.module.control(), self.bench.clock.now_ms());
        let zone = Arc::new(FakeTimeZone::new("Europe/Istanbul", 180));
        let new = NewItem {
            kind: ItemKind::Question,
            producer: "routines".into(),
            routine_id: Some(routine.to_owned()),
            run_id: None,
            subject_key: None,
            title: "t".into(),
            summary: "s".into(),
            payload: json!({}),
            by_hand: false,
        };
        let open = move |tx: &dyn eos_core::store::Tx, out: &mut eos_core::store::Outbox| {
            let at = Opening { now, ids: &ids, zone: zone.as_ref(), control: control.as_ref() };
            open_in(tx, out, &at, new)
        };
        self.bench.temp.store.write_blocking(open).expect("opens")
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn paused_and_archived_routines_leave_no_queued_run_that_may_not_start() {
    let routes = Routes::new();
    let routine = routes.bench.routine_with(RoutineState::Active, blueprint(1), true);
    let hand = routes.queued(&routine, RunOrigin::Hand, 1).await;
    let agents = routes.queued(&routine, RunOrigin::Agent { worker_id: "w-chat".into() }, 2).await;

    let (status, row) = routes.set_state(&routine, "paused").await;
    assert_eq!((status, row["state"].as_str(), row["pausedReason"].as_str()), (200, Some("paused"), Some("user")));
    assert_eq!(routes.bench.state(&agents), RunState::Skipped, "a run the user did not start is skipped");
    assert_eq!(routes.bench.state(&hand), RunState::Queued, "the user's own run still starts");

    let (status, row) = routes.set_state(&routine, "archived").await;
    assert_eq!((status, row["state"].as_str()), (200, Some("archived")));
    assert_eq!(routes.bench.state(&hand), RunState::Skipped, "an archived routine starts nothing");

    let (status, row) = routes.set_state(&routine, "active").await;
    assert_eq!((status, row["state"].as_str(), &row["pausedReason"]), (200, Some("active"), &Value::Null));
    let reasons: Vec<Value> = routes.changes().into_iter().map(|change| change["reason"].clone()).collect();
    assert_eq!(reasons, [json!("state"), json!("state"), json!("state")]);
    assert!(routes.changes().iter().all(|change| change["row"]["id"] == json!(routine)), "each with its row");

    let draft = routes.bench.routine(RoutineState::Draft, blueprint(1));
    assert_eq!(routes.set_state(&draft, "active").await.0, 409, "a draft starts from its draft");
    assert_eq!(routes.set_state(&routine, "deleted").await.0, 400);
    assert_eq!(routes.set_state("rt-missing", "paused").await.0, 404);
}

#[tokio::test(flavor = "multi_thread")]
async fn delete_cancels_the_runs_and_withdraws_the_items_and_undelete_brings_it_back_paused() {
    let routes = Routes::new();
    let bench = &routes.bench;
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let queued = routes.queued(&routine, RunOrigin::Hand, 1).await;
    let working = bench.hand(&routine, Some(pull_request(2))).await;
    bench.supervise().await;
    bench.eventually(|| bench.run(&working).station == Some(Station::Work)).await;
    let lead = bench.run(&working).lead_id.expect("a lead");
    let item = routes.item(&routine);

    let path = format!("/api/routines/{routine}");
    let (status, row) = routes.call(Method::Delete, Caller::DASHBOARD, &path, None).await;
    assert_eq!((status, row["state"].as_str()), (200, Some("deleted")));
    for run in [&queued, &working] {
        assert_eq!((bench.state(run), bench.run(run).reason), (RunState::Cancelled, Some(Reason::User)));
    }
    let id = item.id.clone();
    let found = bench.temp.store.read_blocking(move |tx| tx.inbox_items().find(&id)).expect("reads").expect("one");
    assert_eq!(found.state, ItemState::Withdrawn);
    assert!(routes.routine_row(&routine).deleted_at.is_some());
    assert_eq!(routes.changes().last().map(|change| change["reason"].clone()), Some(json!("deleted")));
    let suspended = || {
        let id = lead.clone();
        let worker = bench.temp.store.read_blocking(move |tx| tx.workers().find(&id)).expect("reads");
        worker.is_some_and(|worker| worker.state == WorkerState::Suspended)
    };
    bench.eventually(suspended).await;
    assert_eq!(routes.set_state(&routine, "active").await.0, 404, "a deleted routine is not set by hand");
    assert_eq!(routes.call(Method::Delete, Caller::DASHBOARD, &path, None).await.0, 404);

    let (status, row) = routes.post(&format!("{path}/undelete"), json!({})).await;
    assert_eq!((status, row["state"].as_str(), row["pausedReason"].as_str()), (200, Some("paused"), Some("user")));
    assert_eq!(routes.routine_row(&routine).deleted_at, None);
    assert_eq!(routes.post(&format!("{path}/undelete"), json!({})).await.0, 409, "it is not deleted");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_one_off_is_kept_as_a_standing_routine() {
    let routes = Routes::new();
    let routine = routes.bench.routine(RoutineState::Active, blueprint(1));
    let path = format!("/api/routines/{routine}/keep");
    assert_eq!(routes.post(&path, json!({})).await.0, 409, "only a one-off is kept");

    let id = routine.clone();
    routes
        .bench
        .temp
        .store
        .write_blocking(move |tx, _| tx.routines().set_kind(&id, RoutineKind::Once, 1))
        .expect("a one-off");
    let (status, row) = routes.post(&path, json!({})).await;
    assert_eq!((status, row["kind"].as_str(), row["state"].as_str()), (200, Some("standing"), Some("active")));
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_users_dashboard_changes_a_routine_and_the_phone_only_its_state() {
    let routes = Routes::new();
    let routine = routes.bench.routine(RoutineState::Active, blueprint(1));
    let state = format!("/api/routines/{routine}/state");
    let paused = Some(json!({"state": "paused"}));
    let low = Caller::Phone { grant: Tier::Low, mutate: true };
    let read = Caller::Phone { grant: Tier::Read, mutate: true };
    assert_eq!(routes.call(Method::Put, Caller::UNTRUSTED, &state, paused.clone()).await.0, 403);
    assert_eq!(routes.call(Method::Put, read, &state, paused.clone()).await.0, 403);
    assert_eq!(routes.call(Method::Put, low.clone(), &state, paused).await.0, 200);
    for (method, path) in [
        (Method::Delete, format!("/api/routines/{routine}")),
        (Method::Post, format!("/api/routines/{routine}/undelete")),
        (Method::Post, format!("/api/routines/{routine}/keep")),
    ] {
        assert_eq!(routes.call(method, low.clone(), &path, None).await.0, 403, "{path}");
        assert_eq!(routes.call(method, Caller::UNTRUSTED, &path, None).await.0, 403, "{path}");
    }
}
