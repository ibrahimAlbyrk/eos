//! `RunStarter::start`: what it writes in its one job, and every refusal.

use eos_contracts::{RoutineState, RunInput};
use eos_core::routine::{NewRun, RunOrigin, StartError};
use eos_domain::routine::run::RunState;
use serde_json::json;

use crate::bench::{Bench, HOUR, blueprint, new_run, pull_request};

#[tokio::test(flavor = "multi_thread")]
async fn a_start_queues_a_run_per_item_with_its_events_and_manual_signals_in_one_job() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let mut new = new_run(&routine, RunOrigin::Hand, None);
    new.items = vec![pull_request(1), pull_request(2)];
    new.input.options.insert("depth".into(), json!("deep"));

    let made = bench.start(new).await.expect("starts");

    assert_eq!(made.iter().map(|run| run.state).collect::<Vec<_>>(), [RunState::Queued, RunState::Queued]);
    let ids: Vec<String> = made.iter().map(|run| run.id.clone()).collect();
    for (id, number) in ids.iter().zip([1, 2]) {
        let run = bench.run(id);
        assert_eq!((run.origin.as_str(), run.priority, run.door.as_deref()), ("hand", 0, Some("routine_page")));
        assert_eq!(run.item_key, Some(format!("github:pr:acme/game#{number}")));
        assert_eq!(run.version_id, None, "a version is bound when the run leaves the queue");
        let input: RunInput = serde_json::from_str(&run.input).expect("an input");
        assert_eq!(input.item.and_then(|item| item.key), run.item_key, "one item each");
        assert_eq!(input.options["depth"], "deep");
    }
    let events = bench.temp.store.read_blocking({
        let id = ids[0].clone();
        move |tx| tx.runs().events(&id)
    });
    let events = events.expect("reads");
    assert_eq!(
        events.iter().map(|e| (e.kind.as_str(), e.data.as_deref())).collect::<Vec<_>>(),
        [("state", Some(r#"{"state":"queued"}"#))]
    );
    // The signals of a hand start: one each, routed to its run.
    let routes = bench.temp.store.read_blocking(|tx| {
        let mut routes = Vec::new();
        for id in 1..=2 {
            let signal = tx.signals().find(id)?.expect("a signal");
            routes.push((signal.signal.key, tx.signal_routes().by_signal(id)?[0].run_id.clone()));
        }
        Ok(routes)
    });
    let routes = routes.expect("reads");
    assert_eq!(
        routes,
        [(format!("manual:{}", ids[0]), Some(ids[0].clone())), (format!("manual:{}", ids[1]), Some(ids[1].clone()))]
    );
    // Announced after the commit, in the order written.
    let changes = bench.changes();
    assert_eq!(
        changes,
        [
            json!({"runId": ids[0], "routineId": routine, "state": "queued", "station": null}),
            json!({"runId": ids[1], "routineId": routine, "state": "queued", "station": null}),
        ]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn each_refusal_writes_nothing() {
    let bench = Bench::new(true);
    let active = bench.routine(RoutineState::Active, blueprint(1));
    let paused = bench.routine(RoutineState::Paused, blueprint(1));
    let draft = bench.routine(RoutineState::Draft, blueprint(1));
    let archived = bench.routine(RoutineState::Archived, blueprint(1));
    let mut one_at_a_time = blueprint(1);
    one_at_a_time["takes"]["many"] = json!(false);
    let single = bench.routine(RoutineState::Active, one_at_a_time);
    let item = Some(pull_request(1));
    let agent = RunOrigin::Agent { worker_id: "w-chat".into() };
    let invalid = |text: &str| Err(StartError::Invalid(text.into()));

    let refused = |new: NewRun| async { bench.start(new).await.map(|_| ()) };
    assert_eq!(
        refused(new_run("rt-none", RunOrigin::Hand, item.clone())).await,
        Err(StartError::UnknownRoutine("rt-none".into()))
    );
    assert_eq!(
        refused(new_run(&archived, RunOrigin::Hand, item.clone())).await,
        Err(StartError::RoutineState(RoutineState::Archived))
    );
    assert_eq!(
        refused(new_run(&paused, agent.clone(), item.clone())).await,
        Err(StartError::RoutineState(RoutineState::Paused))
    );
    assert_eq!(
        refused(new_run(&draft, RunOrigin::Hand, item.clone())).await,
        Err(StartError::RoutineState(RoutineState::Draft))
    );
    assert_eq!(
        refused(new_run(&active, agent, item.clone())).await,
        invalid("origin: the routine does not let agents start it")
    );
    assert_eq!(
        refused(new_run(&active, RunOrigin::Routine { run_id: "rn-other".into() }, item.clone())).await,
        invalid("origin: the routine's When does not name that routine")
    );
    assert_eq!(refused(new_run(&active, RunOrigin::Hand, None)).await, invalid("item: Required"));
    let mut unknown = new_run(&active, RunOrigin::Hand, item.clone());
    unknown.input.options.insert("colour".into(), json!("red"));
    assert_eq!(refused(unknown).await, invalid("options.colour: not a value the routine takes"));
    let mut wrong = new_run(&active, RunOrigin::Hand, item.clone());
    wrong.input.options.insert("depth".into(), json!("very"));
    assert_eq!(refused(wrong).await, invalid("options.depth: not a value the routine takes"));
    let mut long = new_run(&active, RunOrigin::Hand, item.clone());
    long.input.note = Some("x".repeat(4_001));
    assert_eq!(refused(long).await, invalid("note: String must contain at most 4000 character(s)"));
    let mut many = new_run(&active, RunOrigin::Hand, None);
    many.items = (0..21).map(pull_request).collect();
    assert_eq!(refused(many).await, invalid("items: at most 20"));
    let mut two = new_run(&single, RunOrigin::Hand, None);
    two.items = vec![pull_request(1), pull_request(2)];
    assert_eq!(refused(two).await, invalid("items: the routine takes one item at a time"));

    let written = bench.temp.store.read_blocking(|tx| tx.runs().queued()).expect("reads");
    assert!(written.is_empty(), "nothing was queued");
    assert!(bench.changes().is_empty(), "nothing was announced");

    // What those states do take.
    bench.hand(&paused, item.clone()).await;
    bench.start(new_run(&draft, RunOrigin::Trial, item)).await.expect("a draft runs its trial");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_item_again_names_the_earlier_run_until_the_user_confirms() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let first = bench.hand(&routine, Some(pull_request(7))).await;

    let again = bench.start(new_run(&routine, RunOrigin::Hand, Some(pull_request(7)))).await;
    assert_eq!(again, Err(StartError::SameItem { existing_run_id: first.clone() }));
    // Another item is no repeat.
    bench.hand(&routine, Some(pull_request(8))).await;

    let mut confirmed = new_run(&routine, RunOrigin::Hand, Some(pull_request(7)));
    confirmed.confirm_repeat = true;
    let second = bench.start(confirmed).await.expect("starts anyway").remove(0).id;
    assert_ne!(second, first);

    // A day after it ended, the item is new again.
    bench.runs.stop(&first, eos_domain::routine::run::Reason::User).await.expect("stops");
    bench.runs.stop(&second, eos_domain::routine::run::Reason::User).await.expect("stops");
    bench.clock.advance(25 * HOUR);
    bench.hand(&routine, Some(pull_request(7))).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_retried_request_answers_the_runs_it_made_for_ten_minutes() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let request = || NewRun {
        client_request_id: Some("c-1".into()),
        ..new_run(&routine, RunOrigin::Hand, Some(pull_request(3)))
    };
    let made = bench.start(request()).await.expect("starts");
    assert_eq!(bench.start(request()).await, Ok(made.clone()), "the same runs, nothing written");
    let queued = bench.temp.store.read_blocking(|tx| tx.runs().queued()).expect("reads");
    assert_eq!(queued.len(), 1);

    bench.clock.advance(11 * 60 * 1000);
    let later = bench.start(request()).await;
    assert_eq!(later, Err(StartError::SameItem { existing_run_id: made[0].id.clone() }), "checked as a new start");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_store_error_part_way_keeps_and_announces_none_of_the_starts_runs() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    // The second run of the start cannot be written.
    bench.temp.exec(
        "CREATE TRIGGER one_run BEFORE INSERT ON runs WHEN (SELECT COUNT(*) FROM runs) >= 1 \
         BEGIN SELECT RAISE(ABORT, 'one run only'); END",
    );
    let mut new = new_run(&routine, RunOrigin::Hand, None);
    new.items = vec![pull_request(1), pull_request(2)];

    assert!(matches!(bench.start(new).await, Err(StartError::Store(_))));

    let written = bench.temp.store.read_blocking(|tx| tx.runs().queued()).expect("reads");
    assert!(written.is_empty(), "the first run was undone with the second");
    assert!(bench.changes().is_empty(), "nothing was announced");
}
