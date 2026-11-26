//! The sample routines of `eos_testkit::routine_seed` read back through the
//! routes the dashboard reads.

use eos_testkit::routine_seed::{self, PR_REVIEW, RUN_FAILED, RUN_SHOWN};
use serde_json::json;

use crate::run_routes::Routes;

#[tokio::test(flavor = "multi_thread")]
async fn the_sample_routines_read_back_through_the_routes() {
    let routes = Routes::new();
    assert!(routine_seed::seed(routes.bench.temp.port().as_ref()).await.expect("seeds"));

    let (status, list) = routes.get("/api/routines").await;
    assert_eq!(status, 200);
    let rows: Vec<(&str, &str)> = list
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| (row["name"].as_str().expect("a name"), row["state"].as_str().expect("a state")))
        .collect();
    assert_eq!(rows, [("PR Review", "active"), ("Morning Paper", "paused"), ("Release Notes", "draft")]);

    let (status, detail) = routes.get(&format!("/api/routines/{PR_REVIEW}")).await;
    assert_eq!(status, 200);
    assert_eq!(detail["head"]["number"], json!(2));
    assert_eq!(detail["head"]["blueprint"]["who"]["depth"], json!("team"));
    assert_eq!(detail["runs"].as_array().map(Vec::len), Some(4));
    assert_eq!(detail["runs"][0]["id"], json!(RUN_SHOWN), "newest first");
    assert_eq!(routes.get(&format!("/api/routines/{PR_REVIEW}/versions")).await.1.as_array().map(Vec::len), Some(2));

    let (status, result) = routes.get(&format!("/api/runs/{RUN_SHOWN}/result")).await;
    assert_eq!(status, 200, "{result}");
    let (_, failed) = routes.get(&format!("/api/runs/{RUN_FAILED}")).await;
    let run = &failed["run"];
    assert_eq!((run["state"].as_str(), run["reason"].as_str()), (Some("failed"), Some("no_result")));
    assert_eq!((run["station"].as_str(), failed["attempt"].as_i64()), (Some("work"), Some(1)));
    let (_, events) = routes.get(&format!("/api/runs/{RUN_FAILED}/events")).await;
    assert!(!events.to_string().contains("checking"), "no check on its timeline: {events}");
}
