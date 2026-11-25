//! The failure policy: three failed runs in a row pause the routine with one
//! alert, a run that ends well starts the count again, a run that spends far
//! more than usual pauses it too, and most of today's budget spent is told
//! once. A run with no credential fails at once, and three of them pause
//! the routine for a sign-in.

use eos_contracts::RoutineState;
use eos_core::routine::{RunOrigin, SubmittedResult};
use eos_core::store::{StoredItem, StoredRoutine};
use eos_domain::inbox::ItemKind;
use eos_domain::routine::run::{Reason, RunState, Station};
use eos_domain::worker::Usage;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint, new_run, pull_request};

fn generous() -> Value {
    let mut generous = blueprint(1);
    generous["limits"] = json!({"perRunUsd": 50.0, "perRunMinutes": 30, "perDayUsd": 100.0, "parallel": 1});
    generous
}

impl Bench {
    async fn at_work(&self, routine: &str, number: u32) -> (String, String) {
        let new = new_run(routine, RunOrigin::Hand, Some(pull_request(number)));
        let id = self.start(new).await.expect("starts").remove(0).id;
        self.eventually(|| self.run(&id).station == Some(Station::Work)).await;
        (id.clone(), self.run(&id).lead_id.expect("a lead"))
    }

    async fn fails(&self, routine: &str, number: u32) {
        let (run, lead) = self.at_work(routine, number).await;
        self.module.tools().report_failure(&lead, "It broke.").await.expect("reported");
        assert_eq!(self.state(&run), RunState::Failed);
    }

    async fn ends_well(&self, routine: &str, number: u32) -> String {
        let (run, lead) = self.at_work(routine, number).await;
        let nothing =
            SubmittedResult { kind: "nothing".into(), headline: "Quiet".into(), body: json!("-"), files: vec![] };
        self.module.tools().submit_result(&lead, nothing).await.expect("handed in");
        self.eventually(|| self.state(&run) == RunState::Done).await;
        run
    }

    fn stored(&self, routine: &str) -> StoredRoutine {
        let id = routine.to_owned();
        self.temp.store.read_blocking(move |tx| tx.routines().find(&id)).expect("reads").expect("the routine")
    }

    fn alerts(&self, subject: &str) -> Vec<StoredItem> {
        let subject = subject.to_owned();
        let items = self.temp.store.read_blocking(move |tx| tx.inbox_items().waiting_with_subject(&subject));
        items.expect("reads").into_iter().filter(|item| item.kind == ItemKind::RoutineAlert).collect()
    }

    /// What a session's model cost, as the session service books and announces it.
    fn spends(&self, worker_id: &str, usd: f64) {
        let worker = worker_id.to_owned();
        self.temp
            .store
            .write_blocking(move |tx, out| {
                tx.workers().add_usage(&worker, &Usage { cost_usd: usd, ..Usage::default() })?;
                out.push("usage:recorded", &json!({"workerId": worker, "deltaCost": usd}));
                Ok(())
            })
            .expect("books");
    }

    /// What a session's model cost, written on its worker.
    fn costs(&self, worker_id: &str, usd: f64) {
        let worker = worker_id.to_owned();
        self.temp
            .store
            .write_blocking(move |tx, _| tx.workers().add_usage(&worker, &Usage { cost_usd: usd, ..Usage::default() }))
            .expect("books");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn three_failures_in_a_row_pause_with_one_alert_and_a_good_run_starts_the_count_again() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    bench.supervise().await;
    bench.fails(&routine, 1).await;
    bench.fails(&routine, 2).await;
    assert_eq!(bench.stored(&routine).failure_streak, 2);
    bench.ends_well(&routine, 3).await;
    assert_eq!(bench.stored(&routine).failure_streak, 0, "a run that ended well");

    for n in 4..=6 {
        bench.fails(&routine, n).await;
    }
    let paused = bench.stored(&routine);
    assert_eq!(
        (paused.state, paused.paused_reason.as_deref(), paused.failure_streak),
        (RoutineState::Paused, Some("failures"), 3)
    );
    let alerts = bench.alerts("failures");
    assert_eq!(alerts.len(), 1);
    assert_eq!(alerts[0].summary, "Paused after three failed runs in a row.");
    assert_eq!(alerts[0].routine_id.as_deref(), Some(routine.as_str()));

    // A fourth failure, by hand while paused, opens no second alert.
    bench.fails(&routine, 7).await;
    assert_eq!(bench.alerts("failures").len(), 1);

    // Resumed, the count starts over: one more failure does not pause it again.
    let (control, id) = (bench.module.control(), routine.clone());
    bench
        .temp
        .store
        .write_blocking(move |tx, out| {
            control.resume_in(tx, out, &id, "failures").map_err(|_| eos_core::Error::Conflict("refused".into()))
        })
        .expect("resumed");
    assert_eq!((bench.stored(&routine).state, bench.stored(&routine).failure_streak), (RoutineState::Active, 0));
    bench.fails(&routine, 8).await;
    assert_eq!(bench.stored(&routine).state, RoutineState::Active);
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_without_a_credential_fail_at_once_and_three_pause_the_routine_for_a_sign_in() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    bench.supervise().await;
    *bench.credentials.new_session.lock().expect("credential") = None;
    for number in 1..=3 {
        let new = new_run(&routine, RunOrigin::Hand, Some(pull_request(number)));
        let id = bench.start(new).await.expect("starts").remove(0).id;
        bench.eventually(|| bench.state(&id) == RunState::Failed).await;
        let failed = bench.run(&id);
        assert_eq!(failed.reason, Some(Reason::NoCredential));
        assert!(failed.lead_id.is_none(), "no session started");
    }
    let paused = bench.stored(&routine);
    assert_eq!((paused.state, paused.paused_reason.as_deref()), (RoutineState::Paused, Some("sign_in")));
    let alerts = bench.alerts("sign_in");
    assert_eq!(alerts.len(), 1);
    assert!(alerts[0].summary.contains("Settings › Accounts"), "{}", alerts[0].summary);
    assert!(bench.alerts("failures").is_empty(), "one item, for the sign-in");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_that_spends_far_more_than_usual_pauses_its_routine() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, generous());
    bench.supervise().await;
    for n in 1..=3 {
        bench.ends_well(&routine, n).await;
    }
    assert_eq!(bench.stored(&routine).state, RoutineState::Active, "usual runs");

    let (run, lead) = bench.at_work(&routine, 4).await;
    bench.costs(&lead, 4.0);
    let nothing = SubmittedResult { kind: "nothing".into(), headline: "Quiet".into(), body: json!("-"), files: vec![] };
    bench.module.tools().submit_result(&lead, nothing).await.expect("handed in");
    bench.eventually(|| bench.state(&run) == RunState::Done).await;
    let paused = bench.stored(&routine);
    assert_eq!((paused.state, paused.paused_reason.as_deref()), (RoutineState::Paused, Some("spend")));
    assert_eq!(bench.alerts("spend").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn ninety_percent_of_today_s_budget_is_told_once() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, generous());
    bench.supervise().await;
    let (_, lead) = bench.at_work(&routine, 1).await;
    let notices = || {
        let items = bench.temp.store.read_blocking(|tx| tx.inbox_items().waiting_with_subject("day-budget"));
        items.expect("reads").into_iter().filter(|item| item.kind == ItemKind::Notice).collect::<Vec<_>>()
    };
    let booked = || {
        let rows = bench.temp.store.read_blocking(|tx| tx.routine_spend().of_day("2027-01-15")).expect("reads");
        rows.iter().map(|row| row.cost_usd).sum::<f64>()
    };
    for usd in [10.0, 7.0] {
        bench.spends(&lead, usd);
    }
    bench.eventually(|| booked() > 16.99).await;
    assert!(notices().is_empty(), "under 90 %");
    bench.spends(&lead, 1.5);
    bench.eventually(|| !notices().is_empty()).await;
    bench.spends(&lead, 0.5);
    bench.eventually(|| booked() > 18.99).await;
    let told = notices();
    assert_eq!(told.len(), 1, "once");
    assert!(told[0].title.starts_with("Routines have spent $18"), "{}", told[0].title);
    assert!(told[0].title.ends_with("of today's $20"), "{}", told[0].title);
}
