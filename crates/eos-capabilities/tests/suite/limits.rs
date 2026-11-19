//! Four calls of one capability run at once and 64 wait; the next is busy.

use std::sync::Arc;
use std::time::Duration;

use eos_core::capability::{ActionError, CapabilityCalls};
use eos_testkit::FakeBuiltin;
use serde_json::json;
use tokio::task::JoinHandle;

use crate::rig::{GITHUB, agent_call, github_rig};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_fifth_call_waits_and_one_more_than_64_waiting_is_busy() {
    let github = Arc::new(FakeBuiltin::new(GITHUB).held());
    let rig = github_rig(github.clone()).await;
    let spawn = |n: u64| -> JoinHandle<_> {
        let service = rig.service.clone();
        tokio::spawn(
            async move { service.call(agent_call("github", "get_pull_request", json!({ "number": n }))).await },
        )
    };

    let mut running: Vec<_> = (1..=5).map(spawn).collect();
    while github.calls().len() < 4 {
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(github.calls().len(), 4, "the fifth waits for a slot");

    running.extend((6..=69).map(spawn));
    // 4 run and 64 wait: whichever of the 65 that do not run comes last is busy.
    let busy = loop {
        if let Some(at) = running.iter().position(JoinHandle::is_finished) {
            break running.swap_remove(at).await.expect("joins");
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    };
    assert_eq!(busy, Err(ActionError::Busy));
    assert_eq!(github.calls().len(), 4, "still four at once");
    let row = "SELECT COUNT(*) FROM capability_calls WHERE outcome = 'busy' AND error_kind = 'busy'";
    assert_eq!(rig.temp.count(row), 1);

    github.release(68);
    for call in running {
        call.await.expect("joins").expect("each waiting call runs in the end");
    }
    assert_eq!(github.calls().len(), 68);
}
