//! `run:activity`: one line per agent event of a run session, the tool and
//! its target or the text's first line, at most one a second per run.

use std::time::Duration;

use eos_contracts::{RoutineState, RunActivity};
use eos_domain::routine::run::Station;
use eos_testkit::Turn;
use serde_json::json;

use crate::bench::{Bench, blueprint, pull_request};

#[tokio::test(flavor = "multi_thread")]
async fn a_runs_agents_send_one_line_a_second_at_most() {
    let bench = Bench::new(true);
    let routine = bench.routine(RoutineState::Active, blueprint(1));
    let run = bench.hand(&routine, Some(pull_request(1))).await;
    bench.supervise().await;
    bench.eventually(|| bench.run(&run).station == Some(Station::Work)).await;
    let lead = bench.run(&run).lead_id.expect("a lead");
    bench.agents.settled().await;
    let mut lines = bench.bus.subscribe("run:activity", 16);
    // The lead's first turn had its line this second.
    bench.clock.advance(1_000);

    let mut input = eos_contracts::UnknownRecord::new();
    input.insert("file_path".into(), json!("src/login.rs"));
    bench.agents.wake(&lead, Turn::tool("Read", input, "fn login() {}", "Found the login."));
    bench.agents.settled().await;
    bench.clock.advance(1_000);
    bench.agents.wake(&lead, Turn::reply("\nWriting the review\nwith two points"));
    bench.agents.settled().await;
    bench.bus.flush().await;

    let mut got = Vec::new();
    while let Ok(Ok(event)) = tokio::time::timeout(Duration::from_millis(200), lines.recv()).await {
        got.push(event.payload_as::<RunActivity>().expect("a line"));
    }
    let said: Vec<(&str, Option<&str>, &str)> =
        got.iter().map(|a| (a.worker_id.as_str(), a.agent_key.as_deref(), a.line.as_str())).collect();
    assert_eq!(
        said,
        [(lead.as_str(), Some("editor"), "Read src/login.rs"), (lead.as_str(), Some("editor"), "Writing the review")],
        "the text right after the tool call came within the same second"
    );
    assert!(got.iter().all(|a| a.run_id == run));
}
