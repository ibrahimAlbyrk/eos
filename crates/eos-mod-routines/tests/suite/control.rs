//! `RoutineControl`: what the user confirmed, Freedom changes as new
//! versions, pauses and resumes, and the routines a capability serves.

use eos_contracts::{RoutineState, Rung, VersionAuthor, VersionStatus};
use eos_core::store::StoredVersion;
use eos_domain::routine::blueprint::{Readable, canonical_json, hash, read};
use eos_domain::run_scope::Trust;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint};

impl Bench {
    /// Adds a version to `routine` and makes it the head.
    fn version(
        &self,
        routine: &str,
        blueprint: Value,
        author: VersionAuthor,
        status: VersionStatus,
        at: i64,
    ) -> String {
        let Ok(Readable::Current(typed)) = read(&blueprint) else { panic!("a blueprint of this app") };
        let text = canonical_json(&typed);
        let version = StoredVersion {
            id: eos_core::Ids::routine_version_id(self.ids.as_ref()),
            routine_id: routine.into(),
            parent_id: None,
            status,
            author,
            note: None,
            format: 1,
            hash: hash(&text),
            blueprint: text,
            no_trial: false,
            trust: Trust::Trusted,
            device: None,
            created_at: at,
        };
        let (id, routine) = (version.id.clone(), routine.to_owned());
        let head = id.clone();
        self.temp
            .store
            .write_blocking(move |tx, _| {
                tx.routine_versions().insert(&version)?;
                tx.routines().set_head(&routine, &head, at)
            })
            .expect("writes");
        id
    }

    fn rung(&self, routine: &str) -> (Rung, VersionAuthor, Option<String>) {
        let id = routine.to_owned();
        let head = self.temp.store.read_blocking(move |tx| tx.routine_versions().head(&id)).expect("reads");
        let head = head.expect("a head");
        let Ok(Readable::Current(typed)) = read(&serde_json::from_str(&head.blueprint).expect("json")) else {
            panic!("readable")
        };
        (typed.freedom.rung, head.author, head.note)
    }

    fn routine_changes(&self) -> Vec<Value> {
        let announced = self.temp.announced.list().into_iter().filter(|(topic, _)| *topic == "routine:change");
        announced.map(|(_, payload)| serde_json::from_str(&payload).expect("json")).collect()
    }
}

fn with_rung(rung: &str) -> Value {
    let mut blueprint = blueprint(1);
    blueprint["freedom"] = json!({"rung": rung});
    blueprint
}

#[tokio::test(flavor = "multi_thread")]
async fn confirmed_is_the_newest_kept_version_the_user_stands_behind() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, with_rung("send_then_tell"));
    bench.version(&routine, with_rung("on_its_own"), VersionAuthor::Eos, VersionStatus::Kept, 10);
    bench.version(&routine, with_rung("on_its_own"), VersionAuthor::Architect, VersionStatus::Draft, 20);
    let control = bench.module.control();

    let confirmed = control.confirmed(&routine).await.expect("confirmed");
    assert_eq!(confirmed.freedom.rung, Rung::SendThenTell, "neither Eos's version nor a draft counts");
    let in_job = {
        let (control, id) = (control.clone(), routine.clone());
        bench.temp.store.read_blocking(move |tx| control.confirmed_in(tx, &id)).expect("reads")
    };
    assert_eq!(in_job, confirmed);

    bench.version(&routine, with_rung("ask"), VersionAuthor::Architect, VersionStatus::Kept, 30);
    assert_eq!(control.confirmed(&routine).await.expect("confirmed").freedom.rung, Rung::Ask, "started by the user");
    assert_eq!(control.confirmed("rt-none").await, Err(eos_core::Error::not_found("confirmed routine", "rt-none")));
}

#[tokio::test(flavor = "multi_thread")]
async fn raising_and_stepping_down_are_new_kept_heads_that_only_go_their_way() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, with_rung("draft"));
    let control = bench.module.control();

    control.raise(&routine, Rung::SendThenTell).await.expect("raises");
    assert_eq!(bench.rung(&routine), (Rung::SendThenTell, VersionAuthor::User, None));
    control.raise(&routine, Rung::Draft).await.expect("a raise never lowers");
    assert_eq!(bench.rung(&routine).0, Rung::SendThenTell);

    control.step_down(&routine, "a sent review was undone").await.expect("steps down");
    assert_eq!(bench.rung(&routine), (Rung::Draft, VersionAuthor::Eos, Some("a sent review was undone".into())));
    control.step_down(&routine, "again").await.expect("nothing lower to go to");
    let versions = {
        let id = routine.clone();
        bench.temp.store.read_blocking(move |tx| tx.routine_versions().list(&id)).expect("reads")
    };
    assert_eq!(versions.len(), 3, "the seed, the raise, the step down");
    assert_eq!(versions[2].parent_id.as_ref(), Some(&versions[1].id));
    let reasons: Vec<Value> = bench.routine_changes().iter().map(|change| change["reason"].clone()).collect();
    assert_eq!(reasons, [json!("version"), json!("version")]);
    assert_eq!(bench.routine_changes()[1]["row"]["rung"], "draft", "the row as it is now");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_pause_and_its_resume_by_reason() {
    let bench = Bench::new(true);
    let first = bench.routine(RoutineState::Active, blueprint(1));
    let second = bench.routine(RoutineState::Active, blueprint(1));
    let other = bench.routine(RoutineState::Active, blueprint(1));
    let control = bench.module.control();

    control.pause(&first, "capability").await.expect("pauses");
    {
        let (control, id) = (control.clone(), second.clone());
        bench.temp.store.write_blocking(move |tx, out| control.pause_in(tx, out, &id, "capability")).expect("pauses");
    }
    control.pause(&other, "failures").await.expect("pauses");
    let state = |id: &str| {
        let id = id.to_owned();
        let routine = bench.temp.store.read_blocking(move |tx| tx.routines().find(&id)).expect("reads");
        routine.map(|r| (r.state, r.paused_reason)).expect("a routine")
    };
    assert_eq!(state(&first), (RoutineState::Paused, Some("capability".into())));
    assert_eq!(state(&second), (RoutineState::Paused, Some("capability".into())));

    control.resume_paused("capability").await.expect("resumes");
    assert_eq!(state(&first), (RoutineState::Active, None));
    assert_eq!(state(&second), (RoutineState::Active, None));
    assert_eq!(state(&other), (RoutineState::Paused, Some("failures".into())), "paused for another reason");
    let changes = bench.routine_changes();
    assert_eq!(changes.len(), 5);
    assert_eq!((&changes[0]["reason"], &changes[0]["row"]["state"]), (&json!("state"), &json!("paused")));
    assert_eq!(changes[4]["row"]["state"], "active");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_alert_resumes_its_routine_only_while_it_is_paused_for_the_alerts_reason() {
    let bench = Bench::new(true);
    let refused = bench.routine(RoutineState::Active, blueprint(1));
    let by_user = bench.routine(RoutineState::Active, blueprint(1));
    let control = bench.module.control();
    control.pause(&refused, "target_refused").await.expect("pauses");
    control.pause(&by_user, "user").await.expect("pauses");
    for id in [&refused, &by_user] {
        let (control, id) = (control.clone(), id.clone());
        bench
            .temp
            .store
            .write_blocking(move |tx, out| control.resume_in(tx, out, &id, "target_refused"))
            .expect("acts");
    }
    let state = |id: &str| {
        let id = id.to_owned();
        let routine = bench.temp.store.read_blocking(move |tx| tx.routines().find(&id)).expect("reads");
        routine.map(|r| (r.state, r.paused_reason)).expect("a routine")
    };
    assert_eq!(state(&refused), (RoutineState::Active, None));
    assert_eq!(state(&by_user), (RoutineState::Paused, Some("user".into())), "paused for another reason");
    assert_eq!(bench.routine_changes().last().expect("announced")["row"]["state"], "active");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_routines_a_capability_serves_are_those_whose_head_needs_it() {
    let bench = Bench::new(true);
    let mut needs = blueprint(1);
    needs["needs"] = json!(["github", {"id": "mail"}]);
    let reviews = bench.routine(RoutineState::Active, needs.clone());
    bench.routine(RoutineState::Deleted, needs);
    bench.routine(RoutineState::Active, blueprint(1));
    let control = bench.module.control();
    assert_eq!(control.using_capability("github").await, Ok(vec![reviews.clone()]));
    assert_eq!(control.using_capability("mail").await, Ok(vec![reviews]));
    assert_eq!(control.using_capability("slack").await, Ok(vec![]));
}
