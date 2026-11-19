//! Reviews: one request, comments outside the diff, the marker after a
//! crash, the user's own draft, approving, withdrawing.

use eos_core::capability::{ActionError, FailureKind};
use eos_github::{HttpRequest, Method, Transport};
use eos_testkit::GITHUB_TOKEN;
use serde_json::{Value, json};

use crate::rig::{HEAD, REPO, rig};

fn review(event: &str, comments: Value) -> Value {
    json!({ "repo": REPO, "number": 7, "commitId": HEAD, "event": event, "body": "Two notes.", "comments": comments })
}

#[tokio::test]
async fn a_review_is_one_request_with_its_line_comments_and_ends_with_the_marker() {
    let rig = rig();
    let comments = json!([{ "path": "src/main.rs", "line": 30, "body": "Why the change?" }]);
    let receipt = rig.call_with("post_review", review("COMMENT", comments), Some("dl-1")).await.expect("posts");
    assert_eq!(receipt["state"], "COMMENTED");
    assert_eq!((receipt["stale"].clone(), receipt["notesOnOtherLines"].clone()), (json!(false), json!(0)));
    assert_eq!(receipt["alreadyPosted"], false);

    let posts: Vec<String> = rig.requests().into_iter().filter(|request| !request.starts_with("Get")).collect();
    assert_eq!(posts, ["Post /repos/acme/game/pulls/7/reviews"], "one request");
    let sent = rig.fake.reviews(REPO, 7);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["body"], "Two notes.\n\n<!-- eos:d:dl-1 -->");
    assert_eq!(sent[0]["commit_id"], HEAD);
    assert_eq!(sent[0]["comments"][0]["line"], 30);
    assert_eq!(sent[0]["comments"][0]["side"], "RIGHT");
}

#[tokio::test]
async fn comments_github_would_refuse_with_a_422_move_into_the_body() {
    let rig = rig();
    let outside = json!([
        { "path": "src/main.rs", "line": 5, "body": "Far from the change." },
        { "path": "README.md", "line": 1, "body": "Not in this pull request." },
        { "path": "src/main.rs", "line": 31, "body": "Here." },
    ]);
    // GitHub refuses the whole review for such a comment.
    let raw = HttpRequest {
        method: Method::Post,
        url: "https://api.github.com/repos/acme/game/pulls/7/reviews".into(),
        headers: vec![("authorization".into(), format!("Bearer {GITHUB_TOKEN}"))],
        body: Some(
            json!({ "commit_id": HEAD, "body": "x", "event": "COMMENT", "comments": [outside[0]] })
                .to_string()
                .into_bytes(),
        ),
    };
    let refused = rig.fake.send(raw).await.expect("an answer");
    assert_eq!(refused.status, 422);
    let failed = rig
        .call("post_review", json!({ "repo": REPO, "number": 7, "commitId": HEAD, "event": "COMMENT", "body": "x" }))
        .await;
    assert!(failed.is_ok(), "nothing was created by the refused one");

    let receipt = rig.call("post_review", review("COMMENT", outside)).await.expect("posts");
    assert_eq!(receipt["notesOnOtherLines"], 2, "the receipt says what moved");
    let sent = rig.fake.reviews(REPO, 7);
    let body = sent[1]["body"].as_str().expect("a body");
    assert_eq!(
        body,
        "Two notes.\n\n**Notes on other lines**\n\n- `src/main.rs` line 5: Far from the change.\n- `README.md` line 1: Not in this pull request."
    );
    assert_eq!(sent[1]["comments"].as_array().map(Vec::len), Some(1));
}

#[tokio::test]
async fn a_review_a_crash_left_behind_is_found_by_its_marker_and_never_sent_twice() {
    let rig = rig();
    let login = rig.fake.login();
    let left = rig.fake.add_review(REPO, 7, &login, "Two notes.\n\n<!-- eos:d:dl-7 -->", "PENDING");
    let receipt = rig.call_with("post_review", review("COMMENT", json!([])), Some("dl-7")).await.expect("posts");
    assert_eq!((receipt["reviewId"].clone(), receipt["state"].clone()), (json!(left), json!("COMMENTED")));
    assert_eq!(receipt["alreadyPosted"], true);
    assert!(rig.requests().contains(&format!("Post /repos/acme/game/pulls/7/reviews/{left}/events")));

    let again = rig.call_with("post_review", review("COMMENT", json!([])), Some("dl-7")).await.expect("posts");
    assert_eq!((again["reviewId"].clone(), again["alreadyPosted"].clone()), (json!(left), json!(true)));
    assert_eq!(rig.fake.reviews(REPO, 7).len(), 1, "one review, sent once");
    assert!(!rig.requests().contains(&"Post /repos/acme/game/pulls/7/reviews".to_owned()));
}

#[tokio::test]
async fn a_draft_review_of_the_users_own_is_left_alone() {
    let rig = rig();
    let login = rig.fake.login();
    rig.fake.add_review(REPO, 7, &login, "My own notes, not done.", "PENDING");
    let draft = Err(ActionError::Failed { kind: FailureKind::UserDraftInProgress });
    assert_eq!(rig.call_with("post_review", review("COMMENT", json!([])), Some("dl-2")).await, draft.clone());
    assert_eq!(rig.call("post_review", review("COMMENT", json!([]))).await, draft, "GitHub's 422 says the same");
    let reviews = rig.fake.reviews(REPO, 7);
    assert_eq!((reviews.len(), reviews[0]["body"].clone()), (1, json!("My own notes, not done.")));
}

#[tokio::test]
async fn approving_is_its_own_action_and_ones_own_pull_request_cannot_be_approved() {
    let rig = rig();
    let approve = json!({ "repo": REPO, "number": 7, "commitId": HEAD });
    let receipt = rig.call_with("approve_pull_request", approve, Some("dl-3")).await.expect("approves");
    assert_eq!(receipt["state"], "APPROVED");

    let login = rig.fake.login();
    rig.fake.add_pull(REPO, 8, &login, HEAD, 1_763_400_000_000, &[("src/main.rs", crate::rig::PATCH)]);
    let own = json!({ "repo": REPO, "number": 8, "commitId": HEAD });
    let refused = Err(ActionError::Failed { kind: FailureKind::NotAllowed });
    assert_eq!(rig.call("approve_pull_request", own).await, refused.clone());
    let changes = json!({ "repo": REPO, "number": 8, "commitId": HEAD, "event": "REQUEST_CHANGES", "body": "No." });
    assert_eq!(rig.call("post_review", changes).await, refused);
    assert!(rig.fake.reviews(REPO, 8).is_empty(), "nothing was created");
}

#[tokio::test]
async fn a_review_of_a_head_that_moved_is_posted_against_the_drafted_commit_and_said_stale() {
    let rig = rig();
    rig.fake.update_pull(REPO, 7, 1_763_400_100_000, json!({ "head": { "ref": "topic-7", "sha": "f00d" } }));
    let comments = json!([{ "path": "src/main.rs", "line": 30, "body": "Why?" }]);
    let receipt = rig.call("post_review", review("COMMENT", comments)).await.expect("posts");
    assert_eq!(receipt["stale"], true);
    assert_eq!(rig.fake.reviews(REPO, 7)[0]["commit_id"], HEAD);
    let compared = format!("Get /repos/acme/game/compare/b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0...{HEAD}");
    assert!(rig.requests().contains(&compared), "the diff of the drafted commit");
}

#[tokio::test]
async fn withdrawing_deletes_the_comments_replaces_the_text_and_dismisses_a_change_request() {
    let rig = rig();
    let comments = json!([{ "path": "src/main.rs", "line": 30, "body": "Wrong." }]);
    let receipt = rig.call("post_review", review("REQUEST_CHANGES", comments)).await.expect("posts");
    let id = receipt["reviewId"].as_u64().expect("an id");
    let undo = json!({ "repo": REPO, "number": 7, "reviewId": id });
    let withdrawn = rig.call("withdraw_review", undo.clone()).await.expect("withdraws");
    assert_eq!(withdrawn, json!({ "commentsDeleted": 1, "deleted": false, "dismissal": "done" }));
    let review = &rig.fake.reviews(REPO, 7)[0];
    assert_eq!((review["body"].clone(), review["state"].clone()), (json!("Withdrawn."), json!("DISMISSED")));
    assert_eq!(review["comments"], json!([]));

    let receipt = rig.call("post_review", review_with_changes()).await.expect("posts");
    rig.fake.refuse_dismissals();
    let undo = json!({ "repo": REPO, "number": 7, "reviewId": receipt["reviewId"] });
    assert_eq!(rig.call("withdraw_review", undo).await.expect("withdraws")["dismissal"], "failed");

    let login = rig.fake.login();
    let pending = rig.fake.add_review(REPO, 7, &login, "Eos's, pending.", "PENDING");
    let undo = json!({ "repo": REPO, "number": 7, "reviewId": pending });
    assert_eq!(rig.call("withdraw_review", undo).await.expect("withdraws")["deleted"], true);
    assert_eq!(rig.fake.reviews(REPO, 7).len(), 2, "a pending review is deleted outright");
}

fn review_with_changes() -> Value {
    review("REQUEST_CHANGES", json!([]))
}

#[tokio::test]
async fn a_review_is_found_by_the_marker_of_its_delivery() {
    let rig = rig();
    let find = |key: &str| json!({ "repo": REPO, "number": 7, "key": key });
    assert_eq!(rig.call("find_review", find("dl-1")).await.expect("reads"), json!({ "found": false }));
    let login = rig.fake.login();
    let left = rig.fake.add_review(REPO, 7, &login, "Notes.\n\n<!-- eos:d:dl-1 -->", "PENDING");
    rig.fake.add_review(REPO, 7, "someone", "Notes.\n\n<!-- eos:d:dl-2 -->", "COMMENTED");
    let found = rig.call("find_review", find("dl-1")).await.expect("reads");
    assert_eq!(
        (found["found"].clone(), found["reviewId"].clone(), found["state"].clone()),
        (json!(true), json!(left), json!("PENDING"))
    );
    let others = rig.call("find_review", find("dl-2")).await.expect("reads");
    assert_eq!(others["found"], false, "only the user's own reviews count");
    assert!(rig.requests().iter().all(|request| request.starts_with("Get")), "it only reads");
}
