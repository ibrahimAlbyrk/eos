//! Budgets: a run told to wrap up at 90 % of its cost and failed at 100 %,
//! its time cap with its grace, the day caps that skip runs from triggers
//! with one notice and refuse a start by hand, no stop for money where no
//! cap is set, the default caps of older routines taken off once, plan
//! headroom, and spend booked on the user's local day.

use std::sync::Arc;

use eos_contracts::{Num, RoutineState, SettingValue};
use eos_core::Clock;
use eos_core::routine::RunOrigin;
use eos_core::store::{ItemAnswer, StoredItem, StoredSpend};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_domain::worker::Usage;
use eos_inbox::{NewItem, Opening, open_in};
use eos_testkit::FakeTimeZone;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint, new_run, pull_request};
use crate::run_routes::Routes;

const MINUTE: i64 = 60_000;
/// The fake clock's start, 2027-01-15 08:00 UTC, is 11:00 in Istanbul.
const TODAY: &str = "2027-01-15";

impl Bench {
    /// What `worker_id`'s model just cost, as the session service books and
    /// announces it.
    fn spend(&self, worker_id: &str, usd: f64) {
        let worker = worker_id.to_owned();
        self.temp
            .store
            .write_blocking(move |tx, out| {
                let usage = Usage { cost_usd: usd, ..Usage::default() };
                tx.workers().add_usage(&worker, &usage)?;
                out.push("usage:recorded", &json!({"workerId": worker, "deltaCost": usd}));
                Ok(())
            })
            .expect("books");
    }

    fn ledger(&self, day: &str) -> Vec<StoredSpend> {
        let day = day.to_owned();
        self.temp.store.read_blocking(move |tx| tx.routine_spend().of_day(&day)).expect("reads")
    }

    fn booked(&self, day: &str) -> f64 {
        self.ledger(day).iter().map(|row| row.cost_usd).sum()
    }

    /// A run started by hand whose lead works.
    async fn working(&self, routine: &str, number: u32) -> (String, String) {
        let id = self.hand(routine, Some(pull_request(number))).await;
        self.eventually(|| self.run(&id).station == Some(Station::Work)).await;
        (id.clone(), self.run(&id).lead_id.expect("a lead"))
    }

    fn told(&self, lead: &str, words: &str) -> usize {
        self.agents.sent(lead).iter().filter(|text| text.contains(words)).count()
    }

    /// One more turn of the supervisor's loop, `ms` later.
    async fn later(&self, ms: i64) {
        self.clock.advance(ms);
        self.eventually(|| !self.sleeper.pending().is_empty()).await;
        assert!(self.sleeper.wake());
        // The turn has run once the loop sleeps again.
        self.eventually(|| !self.sleeper.pending().is_empty()).await;
    }

    fn day_cap_notices(&self) -> Vec<Option<String>> {
        let items =
            self.temp.store.read_blocking(|tx| tx.inbox_items().waiting_with_subject("day_cap")).expect("reads");
        items.into_iter().filter(|item| item.kind == ItemKind::Notice).map(|item| item.routine_id).collect()
    }

    fn setting(&self, key: &str, value: SettingValue) {
        self.settings.0.lock().expect("settings").insert(key.to_owned(), value);
    }
}

fn limited(per_run_usd: f64, per_run_minutes: i64, per_day_usd: f64) -> Value {
    let mut limited = blueprint(1);
    limited["limits"] = json!({"perRunUsd": per_run_usd, "perRunMinutes": per_run_minutes, "perDayUsd": per_day_usd,
                               "parallel": 1});
    limited
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_is_told_once_to_wrap_up_at_ninety_percent_of_its_cost_and_fails_at_its_cap() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, limited(2.0, 30, 50.0));
    bench.supervise().await;
    let (run, lead) = bench.working(&routine, 1).await;

    bench.spend(&lead, 1.0);
    bench.spend(&lead, 0.8);
    bench.eventually(|| bench.told(&lead, "90% of what it may spend") == 1).await;
    bench.spend(&lead, 0.1);
    bench.eventually(|| bench.booked(TODAY) > 1.89).await;
    assert_eq!(bench.told(&lead, "90% of what it may spend"), 1, "told once");
    assert_eq!(bench.state(&run), RunState::Running);

    bench.spend(&lead, 0.2);
    bench.eventually(|| bench.state(&run) == RunState::Failed).await;
    let failed = bench.run(&run);
    assert_eq!(failed.reason, Some(Reason::BudgetRun));
    // The scripted lead's own turns cost a little too.
    assert!((2.1..2.11).contains(&failed.cost_usd), "the run's row is its sessions' cost: {}", failed.cost_usd);
    let ledger = bench.ledger(TODAY);
    assert_eq!(
        ledger.iter().map(|row| (row.routine_id.as_str(), row.kind.as_str())).collect::<Vec<_>>(),
        [(routine.as_str(), "run")]
    );
    assert!((ledger[0].cost_usd - failed.cost_usd).abs() < 1e-9, "every spend is booked");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_out_of_time_is_told_to_wrap_up_and_fails_two_minutes_after_its_cap() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, limited(5.0, 10, 50.0));
    bench.supervise().await;
    let (run, lead) = bench.working(&routine, 1).await;

    bench.later(8 * MINUTE).await;
    assert_eq!(bench.told(&lead, "90% of its working time"), 0);
    bench.later(MINUTE + MINUTE / 2).await;
    bench.eventually(|| bench.told(&lead, "90% of its working time") == 1).await;
    assert!(bench.run(&run).work_ms >= 9 * MINUTE, "the row is written while the run works");

    bench.later(MINUTE).await;
    assert_eq!(bench.state(&run), RunState::Running, "the cap is reached; the grace begins");
    bench.later(MINUTE).await;
    assert_eq!(bench.state(&run), RunState::Running);
    bench.later(MINUTE + 1).await;
    bench.eventually(|| bench.state(&run) == RunState::Failed).await;
    assert_eq!(bench.run(&run).reason, Some(Reason::BudgetTime));
    assert_eq!(bench.told(&lead, "90% of its working time"), 1);
}

impl Bench {
    /// A question of `run` that waits for the user, as the run's ask opens it.
    fn ask(&self, routine: &str, run: &str) -> StoredItem {
        let (control, now) = (self.module.control(), self.clock.now_ms());
        let (ids, zone) = (self.ids.clone(), Arc::new(FakeTimeZone::new("Europe/Istanbul", 180)));
        let new = NewItem {
            kind: ItemKind::Question,
            producer: "routines".into(),
            routine_id: Some(routine.to_owned()),
            run_id: Some(run.to_owned()),
            subject_key: None,
            title: "t".into(),
            summary: "s".into(),
            payload: json!({}),
            by_hand: false,
        };
        let open = move |tx: &dyn eos_core::store::Tx, out: &mut eos_core::store::Outbox| {
            let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
            open_in(tx, out, &at, new)
        };
        self.temp.store.write_blocking(open).expect("opens")
    }

    fn answered(&self, item: &StoredItem) {
        let (id, rev, at) = (item.id.clone(), item.rev, self.clock.now_ms());
        let answer = ItemAnswer { by: "dashboard".into(), answer: None, at };
        let done = self.temp.store.write_blocking(move |tx, _| tx.inbox_items().answer(&id, rev, &answer));
        assert!(done.expect("answers"));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_time_a_question_waits_for_the_user_is_not_working_time() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, limited(5.0, 10, 50.0));
    bench.supervise().await;
    let (run, lead) = bench.working(&routine, 1).await;

    bench.later(5 * MINUTE).await;
    let question = bench.ask(&routine, &run);
    bench.later(20 * MINUTE).await;
    bench.answered(&question);
    // The wait ends at the first turn that finds the question answered.
    bench.later(MINUTE).await;
    bench.later(MINUTE).await;
    assert_eq!(bench.told(&lead, "90% of its working time"), 0, "six minutes worked");
    assert_eq!(bench.state(&run), RunState::Running);

    bench.later(3 * MINUTE + MINUTE / 2).await;
    bench.eventually(|| bench.told(&lead, "90% of its working time") == 1).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wait_for_the_user_stays_out_of_the_stored_working_time_across_a_restart() {
    use eos_runtime::module::Module;
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, limited(5.0, 60, 50.0));
    bench.supervise().await;
    let (run, _) = bench.working(&routine, 1).await;
    let began = bench.clock.now_ms();

    bench.later(5 * MINUTE).await;
    let question = bench.ask(&routine, &run);
    bench.later(MINUTE).await;
    bench.later(20 * MINUTE).await;
    bench.agents.settled().await;
    bench.module.stop().await;

    let restarted = bench.another_module();
    restarted.after_ready().await.expect("starts");
    let waited = bench.run(&run).work_ms;
    assert!(waited <= 6 * MINUTE, "the wait is no working time: {waited} ms");
    assert!(bench.clock.now_ms() - began > 25 * MINUTE);
    restarted.stop().await;
    drop(question);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_spent_day_skips_runs_from_triggers_with_one_notice_and_asks_before_a_start_by_hand() {
    let routes = Routes::new();
    let bench = &routes.bench;
    let routine = bench.routine_with(RoutineState::Active, limited(2.0, 30, 5.0), true);
    let id = routine.clone();
    bench.temp.store.write_blocking(move |tx, _| tx.routine_spend().add(TODAY, &id, "run", 5.0)).expect("books");
    let agent = |n| new_run(&routine, RunOrigin::Agent { worker_id: "w-chat".into() }, Some(pull_request(n)));
    let first = bench.start(agent(1)).await.expect("queued").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.state(&first) == RunState::Skipped).await;
    assert_eq!(bench.run(&first).reason, Some(Reason::DayCap));
    let second = bench.start(agent(2)).await.expect("queued").remove(0).id;
    bench.eventually(|| bench.state(&second) == RunState::Skipped).await;
    assert_eq!(bench.day_cap_notices(), [Some(routine.clone())], "one notice");

    // The routine's own cap leaves the user's start alone; everything's cap asks first.
    bench.setting("routines.dayBudgetUsd", SettingValue::Number(Num(5.0)));
    let body = json!({"routineId": routine, "input": {"result": "usual"}, "door": "routine_page",
                      "items": [pull_request(3)]});
    let (status, refused) = routes.post("/api/runs", body.clone()).await;
    assert_eq!((status, refused["code"].as_str()), (409, Some("day_cap")), "{refused}");
    let raise = [("day".to_owned(), TODAY.to_owned()), ("usd".to_owned(), "8".to_owned())].into_iter().collect();
    bench.setting("routines.raisedToday", SettingValue::Map(raise));
    assert_eq!(routes.post("/api/runs", body).await.0, 201, "today's cap was raised");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_dollar_caps_neither_a_run_nor_a_day_stops_for_money() {
    let bench = Bench::new(true);
    let mut uncapped = blueprint(1);
    uncapped["limits"] = json!({"perRunMinutes": 30, "parallel": 1});
    let routine = bench.routine_with(RoutineState::Active, uncapped, true);
    let id = routine.clone();
    bench.temp.store.write_blocking(move |tx, _| tx.routine_spend().add(TODAY, &id, "run", 500.0)).expect("books");
    let agent = new_run(&routine, RunOrigin::Agent { worker_id: "w-chat".into() }, Some(pull_request(1)));
    let run = bench.start(agent).await.expect("queued").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");

    bench.spend(&lead, 300.0);
    bench.eventually(|| bench.booked(TODAY) > 799.9).await;
    bench.later(MINUTE).await;
    assert_eq!(bench.state(&run), RunState::Running, "a run with no cap is not stopped by its cost");
    assert_eq!(bench.told(&lead, "90% of what it may spend"), 0);
    assert_eq!(bench.day_cap_notices(), Vec::<Option<String>>::new(), "no day budget runs out");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_plan_headroom_runs_from_triggers_wait_and_runs_by_hand_start() {
    let bench = Bench::new(true);
    let routine = bench.routine_with(RoutineState::Active, blueprint(3), true);
    bench.plan.set_busy(true);
    let agent = new_run(&routine, RunOrigin::Agent { worker_id: "w-chat".into() }, Some(pull_request(1)));
    let waiting = bench.start(agent).await.expect("queued").remove(0).id;
    bench.supervise().await;
    let (hand, _) = bench.working(&routine, 2).await;
    assert_eq!(bench.state(&hand), RunState::Running);
    assert_eq!(bench.state(&waiting), RunState::Queued, "it waits for headroom");

    bench.plan.set_busy(false);
    bench.later(1).await;
    bench.eventually(|| bench.state(&waiting) == RunState::Running).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn spend_is_booked_on_the_users_local_day_when_it_happens() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, limited(50.0, 240, 100.0));
    bench.supervise().await;
    let (_, lead) = bench.working(&routine, 1).await;
    // 20:59 UTC is a minute before midnight in Istanbul.
    bench.clock.set(eos_testkit::FakeClock::START_MS + 13 * 60 * MINUTE - MINUTE);
    let before = bench.booked(TODAY);
    bench.spend(&lead, 0.5);
    bench.eventually(|| bench.booked(TODAY) > before + 0.499).await;
    bench.clock.advance(2 * MINUTE);
    bench.spend(&lead, 0.25);
    bench.eventually(|| bench.booked("2027-01-16") > 0.249).await;
    // The scripted lead's own turns cost a little too, booked on whichever day they end.
    assert!(bench.booked("2027-01-16") < 0.26, "the half dollar stays on the day it was spent");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_run_that_spends_its_day_pauses_with_one_notice_and_goes_on_the_next_day() {
    let bench = Bench::new(true);
    let mut project = crate::project::project();
    project["limits"]["perDayUsd"] = json!(1);
    let routine = bench.routine(RoutineState::Active, project);
    let run = bench.start(new_run(&routine, RunOrigin::Hand, None)).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");

    bench.spend(&lead, 0.6);
    bench.spend(&lead, 0.5);
    bench.eventually(|| bench.state(&run) == RunState::Paused).await;
    assert_eq!(bench.run(&run).reason, Some(Reason::DayCap));
    assert_eq!(bench.day_cap_notices(), [Some(routine.clone())]);
    bench.later(MINUTE).await;
    assert_eq!(bench.state(&run), RunState::Paused, "not today");

    bench.later(24 * 60 * MINUTE).await;
    bench.eventually(|| bench.state(&run) == RunState::Running).await;
    assert_eq!(bench.run(&run).station, Some(Station::Work));
    bench.eventually(|| bench.told(&lead, "A new day") == 1).await;
}

/// A project whose first milestone names caps of its own, as the Forge's research does.
fn capped_project(usd: f64, minutes: i64) -> Value {
    let mut project = crate::project::project();
    project["limits"]["perDayUsd"] = json!(50);
    project["project"]["milestones"][0]["limits"] = json!({"usd": usd, "minutes": minutes});
    project
}

async fn project_at_work(bench: &Bench, project: Value) -> (String, String) {
    let routine = bench.routine(RoutineState::Active, project);
    let run = bench.start(new_run(&routine, RunOrigin::Hand, None)).await.expect("starts").remove(0).id;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    (run, lead)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_milestone_that_names_a_cost_cap_is_held_to_it_like_a_run() {
    let bench = Bench::new(true);
    let (run, lead) = project_at_work(&bench, capped_project(2.0, 120)).await;
    bench.spend(&lead, 1.85);
    bench.eventually(|| bench.told(&lead, "90% of what it may spend") == 1).await;
    assert_eq!(bench.state(&run), RunState::Running);
    bench.spend(&lead, 0.2);
    bench.eventually(|| bench.state(&run) == RunState::Failed).await;
    assert_eq!(bench.run(&run).reason, Some(Reason::BudgetRun));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_milestone_that_names_a_time_cap_is_held_to_it_with_its_grace() {
    let bench = Bench::new(true);
    let (run, lead) = project_at_work(&bench, capped_project(5.0, 10)).await;
    bench.later(9 * MINUTE + MINUTE / 2).await;
    bench.eventually(|| bench.told(&lead, "90% of its working time") == 1).await;
    bench.later(MINUTE).await;
    bench.later(2 * MINUTE + 1).await;
    bench.eventually(|| bench.state(&run) == RunState::Failed).await;
    assert_eq!(bench.run(&run).reason, Some(Reason::BudgetTime));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_project_milestone_without_caps_leaves_the_run_uncapped() {
    let bench = Bench::new(true);
    let mut project = crate::project::project();
    project["limits"]["perDayUsd"] = json!(50);
    let (run, lead) = project_at_work(&bench, project).await;
    // Past the routine's per-run numbers, within the day.
    bench.spend(&lead, 15.0);
    bench.eventually(|| bench.booked(TODAY) >= 15.0).await;
    bench.later(4 * 60 * MINUTE).await;
    assert_eq!(bench.state(&run), RunState::Running, "a project has no cap per run");
    assert_eq!(bench.told(&lead, "Wrap up"), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_dollar_caps_filled_in_by_default_come_off_once_and_a_cap_set_later_stays() {
    use eos_contracts::VersionAuthor;
    use eos_runtime::module::Module;
    let bench = Bench::new(true);
    let filled = bench.routine(RoutineState::Active, limited(1.0, 30, 5.0));
    let drafted = bench.routine(RoutineState::Draft, limited(1.0, 30, 5.0));
    let later = bench.routine(RoutineState::Active, limited(4.0, 30, 9.0));
    bench.temp.exec(&format!("INSERT INTO routine_limit_resets VALUES ('{filled}'), ('{drafted}'), ('gone')"));
    bench.setting("routines.dayBudgetUsd", SettingValue::Number(Num(20.0)));
    let versions = |id: &str| {
        let id = id.to_owned();
        bench.temp.store.read_blocking(move |tx| tx.routine_versions().list(&id)).expect("reads")
    };
    let limits = |id: &str| {
        let head = versions(id).pop().expect("a version");
        (head.author, serde_json::from_str::<Value>(&head.blueprint).expect("json")["limits"].clone())
    };

    bench.supervise().await;
    let (author, uncapped) = limits(&filled);
    assert_eq!((author, uncapped), (VersionAuthor::Eos, json!({"perRunMinutes": 30, "parallel": 1})));
    let kept = json!({"perRunUsd": 4, "perRunMinutes": 30, "perDayUsd": 9, "parallel": 1});
    assert_eq!(limits(&later).1, kept, "a routine made since keeps its caps");
    assert_eq!(versions(&drafted).len(), 1, "a draft waits until it runs from a version");
    let rows = bench.temp.count("SELECT count(*) FROM routine_limit_resets");
    assert_eq!(rows, 1, "only the draft is left to do");
    let stored = bench.settings.0.lock().expect("settings").get("routines.dayBudgetUsd").cloned();
    assert_eq!(stored, Some(SettingValue::Number(Num(0.0))), "the overall day budget is gone");

    // A cap set by hand afterwards stays across a restart.
    bench.module.stop().await;
    bench.setting("routines.dayBudgetUsd", SettingValue::Number(Num(3.0)));
    let restarted = bench.another_module();
    restarted.after_ready().await.expect("starts");
    assert_eq!(versions(&filled).len(), 2, "nothing more is taken off");
    let kept = bench.settings.0.lock().expect("settings").get("routines.dayBudgetUsd").cloned();
    assert_eq!(kept, Some(SettingValue::Number(Num(3.0))));
    restarted.stop().await;
}
