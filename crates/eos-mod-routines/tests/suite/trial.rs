//! The trial: real past items the Which rules take, three show-only runs of
//! the draft that send nothing and report to the architect; a dry run when
//! there is no item; start asks for a trial or the user's choice to go
//! without one.

use eos_contracts::{CapabilityItem, DraftStatus, ResultMode, RunInput};
use eos_core::capability::Checkout;
use eos_core::routine::{GateMode, SubmittedResult};
use eos_domain::routine::run::{RunState, Station};
use eos_testkit::FakeCapabilityReads;
use serde_json::{Value, json};

use crate::bench::{Bench, blueprint};
use crate::run_routes::Routes;

/// Pull request `number`, a draft or not, last changed at `number`.
fn pull(number: i64, draft: bool) -> CapabilityItem {
    CapabilityItem {
        key: format!("github:pr:acme/game#{number}"),
        kind: "github.pull_request".into(),
        title: format!("PR {number}"),
        url: None,
        updated_at: number,
        data: json!({"facts": {"repo": "acme/game", "draft": draft}}),
    }
}

/// PR Review taking the pulls of acme/game that are no drafts, unchecked.
fn reviewing() -> Value {
    let mut blueprint = blueprint(1);
    blueprint["takes"]["source"] = json!("github.pulls");
    blueprint["which"] = json!({"rule": {"fact": "draft", "is": false}});
    blueprint["how"]["checkAgent"] = json!(false);
    blueprint
}

fn shown(headline: &str) -> SubmittedResult {
    let doc = json!({"kind": "github.review", "channel": "github", "action": "post_review",
                     "parts": [{"key": "summary", "role": "summary", "text": "Fine."}]});
    SubmittedResult { kind: "github.review".into(), headline: headline.into(), body: doc, files: vec![] }
}

fn with_pulls() -> Routes {
    let pulls = vec![pull(5, false), pull(4, true), pull(3, false), pull(2, false), pull(1, false)];
    Routes::over(Bench::with_reads(true, FakeCapabilityReads::new().items("github.pulls", pulls)))
}

#[tokio::test(flavor = "multi_thread")]
async fn a_trial_runs_the_draft_on_the_newest_three_items_it_takes_and_sends_nothing() {
    let routes = with_pulls();
    let bench = &routes.bench;
    let (routine, architect) = routes.made("Review the pull requests of acme/game").await;
    let drafted = routes.propose(&architect, reviewing()).await;
    bench.supervise().await;

    let tools = bench.module.architect();
    let past = tools.find_past_items(&architect, 10).await.expect("lists");
    let keys: Vec<_> = past.iter().filter_map(|item| item.key.as_deref()).collect();
    assert_eq!(
        keys,
        ["github:pr:acme/game#5", "github:pr:acme/game#3", "github:pr:acme/game#2", "github:pr:acme/game#1"]
    );
    assert!(past.iter().all(|item| item.untrusted), "outside text");

    let (status, started) = routes.post(&format!("/api/routines/{routine}/trial"), json!({})).await;
    assert_eq!(status, 201, "{started}");
    let runs: Vec<String> = started["runs"]
        .as_array()
        .expect("runs")
        .iter()
        .map(|run| run["id"].as_str().expect("id").to_owned())
        .collect();
    assert_eq!(runs.len(), 3);
    assert_eq!(routes.draft_row(&routine).status, DraftStatus::Trying);
    let (status, _) = routes.post(&format!("/api/routines/{routine}/start"), json!({})).await;
    assert_eq!(status, 409, "no trial went well yet");

    let mut items = Vec::new();
    for run in &runs {
        bench.eventually(|| bench.run(run).station == Some(Station::Work)).await;
        let stored = bench.run(run);
        assert_eq!((stored.kind.as_str(), stored.origin.as_str()), ("trial", "trial"));
        assert_eq!(stored.version_id.as_deref(), Some(drafted.as_str()), "the draft it was started for");
        let input: RunInput = serde_json::from_str(&stored.input).expect("an input");
        assert_eq!(input.result, ResultMode::ShowOnly);
        items.push(input.item.and_then(|item| item.key).expect("an item"));
        let lead = stored.lead_id.expect("a lead");
        bench.module.tools().submit_result(&lead, shown("Looks fine")).await.expect("handed in");
    }
    items.sort();
    assert_eq!(items, ["github:pr:acme/game#2", "github:pr:acme/game#3", "github:pr:acme/game#5"]);
    for run in &runs {
        bench.eventually(|| bench.state(run) == RunState::Done).await;
    }

    let inputs = bench.gate.inputs();
    assert_eq!(inputs.len(), 3);
    assert!(inputs.iter().all(|input| input.result_mode == GateMode::Trial && input.targets.is_empty()));
    assert_eq!(bench.gate.deliveries(), 0, "a trial sends nothing");
    bench
        .eventually(|| bench.agents.sent(&architect).iter().filter(|text| text.contains("Trial run")).count() == 3)
        .await;
    let reports = bench.agents.sent(&architect);
    assert!(reports.iter().any(|text| text.contains("Looks fine")), "{reports:?}");
    bench.eventually(|| routes.draft_row(&routine).status == DraftStatus::Ready).await;
    let (_, draft) = routes.get(&format!("/api/routines/{routine}/draft")).await;
    assert_eq!(draft["trialRuns"].as_array().map(Vec::len), Some(3), "{draft}");

    let (status, row) = routes.post(&format!("/api/routines/{routine}/start"), json!({})).await;
    assert_eq!((status, &row["state"]), (200, &json!("active")), "{row}");
    let kept = routes.versions(&routine).into_iter().find(|version| version.id == drafted).expect("kept");
    assert!(!kept.no_trial, "it was tried");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_routine_with_no_past_item_gets_one_dry_run() {
    let routes = Routes::new();
    let (routine, architect) = routes.made("Write the week's notes").await;
    routes.propose(&architect, blueprint(1)).await;
    let (status, started) = routes.post(&format!("/api/routines/{routine}/trial"), json!({})).await;
    assert_eq!(status, 201, "{started}");
    let runs = started["runs"].as_array().expect("runs");
    assert_eq!(runs.len(), 1);
    let stored = routes.bench.run(runs[0]["id"].as_str().expect("id"));
    let input: RunInput = serde_json::from_str(&stored.input).expect("an input");
    assert!(input.item.is_none(), "no item, though the routine needs one at its runs");
}

#[tokio::test(flavor = "multi_thread")]
async fn start_without_a_trial_is_the_users_choice_and_recorded() {
    let routes = Routes::new();
    let (routine, architect) = routes.made("Review my pull requests").await;
    let drafted = routes.propose(&architect, blueprint(1)).await;
    let (status, refused) = routes.post(&format!("/api/routines/{routine}/start"), json!({})).await;
    assert_eq!((status, refused["code"].as_str()), (409, Some("trial_needed")), "{refused}");
    assert_eq!(routes.routine_head(&routine), None, "nothing was kept");

    let (status, _) = routes.post(&format!("/api/routines/{routine}/start"), json!({"withoutTrial": true})).await;
    assert_eq!(status, 200);
    let kept = routes.versions(&routine).into_iter().find(|version| version.id == drafted).expect("kept");
    assert!(kept.no_trial);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_trial_of_a_change_runs_the_proposed_draft_not_the_head() {
    let routes = Routes::new();
    let bench = &routes.bench;
    let (routine, architect) = routes.made("Review my pull requests").await;
    let head = routes.propose(&architect, blueprint(1)).await;
    routes.post(&format!("/api/routines/{routine}/start"), json!({"withoutTrial": true})).await;
    assert_eq!(routes.routine_head(&routine).as_deref(), Some(head.as_str()));
    routes.post(&format!("/api/routines/{routine}/change"), json!({"text": "Two at once."})).await;
    let proposed = routes.propose(&architect, blueprint(2)).await;

    let (status, started) = routes.post(&format!("/api/routines/{routine}/trial"), json!({})).await;
    assert_eq!(status, 201, "{started}");
    let run = started["runs"][0]["id"].as_str().expect("a run").to_owned();
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station.is_some()).await;
    assert_eq!(bench.run(&run).version_id.as_deref(), Some(proposed.as_str()), "the draft, after leaving the queue");
    assert_eq!(routes.routine_head(&routine).as_deref(), Some(head.as_str()), "the head stays");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_trial_in_a_repository_that_is_no_project_is_refused_before_any_run() {
    let checkout = Checkout {
        remote: "https://github.com/acme/game.git".into(),
        refspec: "pull/5/head".into(),
        sha: "abc".into(),
    };
    let reads = FakeCapabilityReads::new()
        .items("github.pulls", vec![pull(5, false)])
        .checkout_of("github:pr:acme/game#5", checkout);
    let routes = Routes::over(Bench::with_reads(true, reads));
    let bench = &routes.bench;
    let (routine, architect) = routes.made("Review the pull requests of acme/game").await;
    let mut in_worktree = reviewing();
    in_worktree["who"]["agents"][0]["workspace"] = json!("worktree");
    routes.propose(&architect, in_worktree).await;

    let (status, refused) = routes.post(&format!("/api/routines/{routine}/trial"), json!({})).await;
    assert_eq!(
        (status, refused["code"].as_str(), refused["repo"].as_str()),
        (409, Some("no_local_clone"), Some("github.com/acme/game"))
    );
    assert_eq!(
        refused["error"],
        "github.com/acme/game is not a project in Eos. Add your local clone of it as a project, then start again."
    );
    let told = bench.module.architect().start_trial(&architect).await.expect_err("refused");
    assert!(told.to_string().contains("github.com/acme/game is not a project in Eos"), "{told}");
    let id = routine.clone();
    let runs = bench.temp.store.read_blocking(move |tx| tx.runs().by_routine(&id, 10)).expect("reads");
    assert!(runs.is_empty(), "no run was spent");

    bench.keys.clone_at("git:github.com/acme/game", "/tmp/game");
    let (status, started) = routes.post(&format!("/api/routines/{routine}/trial"), json!({})).await;
    assert_eq!(status, 201, "{started}");
}

#[tokio::test(flavor = "multi_thread")]
async fn start_names_the_version_shown_and_the_one_the_trial_ran_on() {
    let routes = Routes::over(Bench::new(false));
    let bench = &routes.bench;
    let (routine, architect) = routes.made("Write the week's notes").await;
    routes.propose(&architect, blueprint(1)).await;
    let (status, started) = routes.post(&format!("/api/routines/{routine}/trial"), json!({})).await;
    assert_eq!(status, 201, "{started}");
    let (status, refused) = routes.post(&format!("/api/routines/{routine}/start"), json!({})).await;
    assert_eq!(
        (status, refused),
        (409, json!({"error": "No trial of version 2 went well yet.", "code": "trial_needed", "version": 2}))
    );

    // The trial went well; then an edit made the version after it.
    let mut done = bench.run(started["runs"][0]["id"].as_str().expect("id"));
    (done.id, done.state) = ("run-done".into(), RunState::Done);
    bench.temp.store.write_blocking(move |tx, _| tx.runs().insert(&done)).expect("writes");
    let mut edited = blueprint(1);
    edited["summary"] = json!("Writes the week's notes, shorter.");
    routes.propose(&architect, edited).await;

    let (status, refused) = routes.post(&format!("/api/routines/{routine}/start"), json!({})).await;
    assert_eq!(
        (status, refused),
        (
            409,
            json!({"error": "Version 3 has not been tried. The trial ran on version 2.", "code": "trial_needed",
                   "version": 3, "triedVersion": 2})
        )
    );
}
