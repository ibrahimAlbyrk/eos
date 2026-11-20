//! A pull request routine's lead in the composed app is told the shape GitHub's channel
//! declares for a review, the two results refused in use are turned away at hand-in with
//! what to change, and the example it was shown is taken.

use std::time::Duration;

use eos_domain::routine::run::{RunState, Station};
use eos_testkit::TempHome;
use serde_json::{Value, json};

use crate::routines_rig::{
    Fakes, call_tool, eventually, lead, make, page, pull, review_blueprint, runs, working_agents,
};

#[tokio::test(flavor = "multi_thread")]
async fn a_review_of_the_wrong_kind_or_shape_is_refused_at_hand_in_and_the_shown_example_is_taken() {
    let (home, agents, fakes) = (TempHome::new(), working_agents(), Fakes::new());
    let app = fakes.app(home.path(), &agents, true);
    app.start().await.expect("starts");
    fakes.source.page(page(vec![pull(7, "a1", "opened", "Fix the login")], false));
    let routine = make(&app, review_blueprint("Review the pull request.")).await;
    eventually("a run is admitted", || async { !runs(&app, &routine).await.is_empty() }).await;
    let run = runs(&app, &routine).await.remove(0).id;
    let lead = lead(&app, &agents, &run).await;

    let brief = agents.started().into_iter().find(|s| s.worker_id == lead).and_then(|s| s.prompt).expect("a brief");
    for told in
        ["Hand in kind `github.review`", "`meta.path`, required", "A remark with no line to point at goes here."]
    {
        assert!(brief.contains(told), "{told} in {brief}");
    }
    let example = brief.split("```json\n").nth(1).and_then(|rest| rest.split("\n```").next()).expect("an example");
    let example: Value = serde_json::from_str(example).expect("JSON");

    let submit = |kind: &str, body: Value| json!({"kind": kind, "headline": "Two notes", "body": body});
    let mut review = example.clone();
    review["kind"] = json!("review");
    let reply = call_tool(&app, &agents, &lead, "submit_result", submit("review", review)).await;
    assert!(reply.is_error, "{}", reply.text);
    assert!(reply.text.contains("this routine makes `github.review`; hand in kind `github.review`"), "{}", reply.text);

    let mut remark = example.clone();
    remark["parts"] = json!([{"key": "body", "role": "text", "text": "Looks fine overall."}]);
    let reply = call_tool(&app, &agents, &lead, "submit_result", submit("github.review", remark)).await;
    assert!(reply.is_error, "{}", reply.text);
    let fix = "part `body`: a line comment needs meta.path and meta.line; put general remarks in the summary part";
    assert!(reply.text.contains(fix), "{}", reply.text);
    let at = crate::routines_rig::run(&app, &run).await;
    assert_eq!((at.state, at.station, at.attempt), (RunState::Running, Some(Station::Work), 1), "no round spent");

    let reply = call_tool(&app, &agents, &lead, "submit_result", submit("github.review", example)).await;
    assert!(!reply.is_error, "{}", reply.text);
    eventually("the result is checked", || async {
        crate::routines_rig::run(&app, &run).await.state == RunState::Checking
    })
    .await;
    app.shutdown(Duration::from_secs(5)).await;
}
