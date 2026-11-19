//! Reading pull requests, and the ones offered to pick.

use eos_core::capability::ActionError;
use serde_json::json;

use crate::rig::{HEAD, REPO, rig};

#[tokio::test]
async fn a_pull_request_reads_with_its_files_and_lists_with_the_others() {
    let rig = rig();
    let pull = rig.call("get_pull_request", json!({ "repo": REPO, "number": 7 })).await.expect("reads");
    assert_eq!(pull["title"], "Change 7");
    assert_eq!(pull["author"], "alice");
    assert_eq!(pull["headSha"], HEAD);
    assert_eq!(pull["base"], "main");
    assert_eq!(pull["files"], json!(["src/main.rs"]));
    assert_eq!(
        rig.requests(),
        ["Get /repos/acme/game/pulls/7", "Get /repos/acme/game/pulls/7/files?per_page=100&page=1"]
    );

    let files = rig.call("get_pull_request_files", json!({ "repo": REPO, "number": 7 })).await.expect("reads");
    assert_eq!(files["files"][0]["additions"], 1);
    assert!(files["files"][0]["patch"].as_str().is_some_and(|patch| patch.starts_with("@@ -27,6")));

    let listed = rig.call("list_pull_requests", json!({ "repo": REPO, "limit": 5 })).await.expect("lists");
    assert_eq!(listed["pullRequests"][0]["number"], 7);
    assert_eq!(listed["pullRequests"][0]["updatedAt"], 1_763_400_000_000_i64);
}

#[tokio::test]
async fn a_repository_name_that_could_leave_its_path_is_refused_before_github_is_asked() {
    let rig = rig();
    for repo in ["acme", "../acme", "acme/..", "acme/game?x=1", "a/b/c"] {
        let refused = rig.call("get_pull_request", json!({ "repo": repo, "number": 7 })).await;
        assert!(
            matches!(refused, Err(ActionError::Invalid(ref text)) if text.contains("repo: Expected owner/name")),
            "{repo}"
        );
    }
    assert!(rig.fake.calls().is_empty());
}

#[tokio::test]
async fn candidates_are_open_pull_requests_as_items_to_pick() {
    let rig = rig();
    let found = rig.call("find_pull_requests", json!({ "q": "network", "limit": 10 })).await.expect("finds");
    let item = &found["items"][0];
    assert_eq!(item["key"], "github:pr:acme/game#7");
    assert_eq!(item["kind"], "github.pull_request");
    assert_eq!(item["url"], "https://github.com/acme/game/pull/7");
    assert_eq!(item["data"]["repo"], REPO);
    let item: eos_contracts::CapabilityItem = serde_json::from_value(item.clone()).expect("a CapabilityItem");
    assert_eq!(item.updated_at, 1_763_400_000_000);
    let search = &rig.requests()[0];
    assert!(search.starts_with("Get /search/issues?q=is%3Apr+is%3Aopen+involves%3A%40me+network&"), "{search}");
}
