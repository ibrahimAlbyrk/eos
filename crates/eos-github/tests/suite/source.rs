//! The pull request source: a first page sets the baseline, a page with an
//! unchanged ETag costs a 304, and changes come back as events.

use serde_json::{Value, json};

use crate::rig::{HEAD, PATCH, REPO, rig};

#[tokio::test]
async fn a_first_page_is_the_baseline_then_a_304_then_the_changes() {
    let rig = rig();
    rig.fake.set_poll_interval(90);
    rig.fake.update_pull(REPO, 7, 1_763_400_000_000, json!({ "draft": true }));
    let first = rig.call("poll_pull_requests", json!({ "repo": REPO })).await.expect("polls");
    assert_eq!((first["items"].clone(), first["baseline"].clone()), (json!([]), json!(true)));
    assert_eq!(first["pollAfterS"], 90, "x-poll-interval");
    let cursor = first["cursor"].clone();
    assert_eq!(cursor["since"], 1_763_400_000_000_i64);
    assert_eq!(cursor["drafts"], json!([7]));

    let unchanged = rig.call("poll_pull_requests", json!({ "repo": REPO, "cursor": cursor })).await.expect("polls");
    assert_eq!((unchanged["items"].clone(), unchanged["cursor"].clone()), (json!([]), cursor.clone()));
    let calls = rig.fake.calls();
    assert_eq!(calls.len(), 2, "a 304 page reads nothing more");

    rig.fake.update_pull(REPO, 7, 1_763_400_060_000, json!({ "draft": false }));
    rig.fake.add_pull(REPO, 9, "bob", HEAD, 1_763_400_120_000, &[("src/net.rs", PATCH), ("README.md", PATCH)]);
    let changed = rig.call("poll_pull_requests", json!({ "repo": REPO, "cursor": cursor })).await.expect("polls");
    let events: Vec<(Value, Value)> = changed["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|item| (item["key"].clone(), item["event"].clone()))
        .collect();
    assert_eq!(
        events,
        [(json!("github:pr:acme/game#7"), json!("ready")), (json!("github:pr:acme/game#9"), json!("opened"))]
    );
    let opened = &changed["items"][1];
    assert_eq!(opened["version"], HEAD);
    assert_eq!(opened["facts"]["paths"], json!(["src/net.rs", "README.md"]));
    assert_eq!(opened["facts"]["size"], 4);
    assert_eq!(opened["facts"]["author"], "bob");
    assert_eq!(changed["cursor"]["since"], 1_763_400_120_000_i64);
    assert_eq!(changed["cursor"]["drafts"], json!([]));

    rig.fake.update_pull(REPO, 9, 1_763_400_180_000, json!({ "state": "closed" }));
    let closed =
        rig.call("poll_pull_requests", json!({ "repo": REPO, "cursor": changed["cursor"] })).await.expect("polls");
    assert_eq!(closed["items"].as_array().map(Vec::len), Some(1));
    assert_eq!(closed["items"][0]["event"], "closed");
}

#[tokio::test]
async fn a_change_in_the_same_second_as_the_last_poll_is_not_lost_nor_told_twice() {
    let rig = rig();
    let first = rig.call("poll_pull_requests", json!({ "repo": REPO })).await.expect("polls");
    let cursor = first["cursor"].clone();
    assert_eq!((cursor["since"].clone(), cursor["atSince"].clone()), (json!(1_763_400_000_000_i64), json!([7])));

    // GitHub's times are whole seconds: #9 lands in the second the last page ended on.
    rig.fake.add_pull(REPO, 9, "bob", HEAD, 1_763_400_000_000, &[("src/net.rs", PATCH)]);
    let next = rig.call("poll_pull_requests", json!({ "repo": REPO, "cursor": cursor })).await.expect("polls");
    let events: Vec<(Value, Value)> =
        next["items"].as_array().expect("items").iter().map(|i| (i["key"].clone(), i["event"].clone())).collect();
    assert_eq!(events, [(json!("github:pr:acme/game#9"), json!("opened"))], "#7 was told before");
    assert_eq!(next["cursor"]["atSince"], json!([7, 9]));

    rig.fake.update_pull(REPO, 7, 1_763_400_000_000, json!({ "title": "Same second again" }));
    let again = rig.call("poll_pull_requests", json!({ "repo": REPO, "cursor": next["cursor"] })).await.expect("polls");
    assert_eq!(again["items"], json!([]), "both were told at that second");
}

#[tokio::test]
async fn a_file_list_cut_at_the_page_cap_names_no_paths_and_no_size() {
    let rig = rig();
    let first = rig.call("poll_pull_requests", json!({ "repo": REPO })).await.expect("polls");
    let names: Vec<String> = (0..3_000).map(|i| format!("docs/page-{i}.md")).collect();
    let files: Vec<(&str, &str)> = names.iter().map(|name| (name.as_str(), PATCH)).collect();
    rig.fake.add_pull(REPO, 9, "bob", HEAD, 1_763_400_120_000, &files);
    let changed =
        rig.call("poll_pull_requests", json!({ "repo": REPO, "cursor": first["cursor"] })).await.expect("polls");
    let facts = &changed["items"][0]["facts"];
    assert_eq!(facts["author"], "bob");
    assert!(facts.get("paths").is_none() && facts.get("size").is_none(), "{facts}");
}
