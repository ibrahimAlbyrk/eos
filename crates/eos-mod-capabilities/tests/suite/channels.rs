//! The `github` channel: one send, found again by its marker after a crash,
//! the user's own draft left alone, GitHub's refusals read as they mean,
//! and a review taken back.

use crate::github::{HEAD, PATCH, REPO, github, review};
use eos_core::delivery::{Fresh, Idempotency, Place, Receipt, SendErrorKind, SendRequest, Target, Undo, UndoOutcome};

fn send(key: &str, action: &str, event: &str, pull: u64, sha: &str) -> SendRequest {
    SendRequest {
        key: key.into(),
        run_id: "rn-1".into(),
        channel: "github".into(),
        action: action.into(),
        target: Target { recipient_id: "pr".into(), place: Place::Item(format!("github:pr:{REPO}#{pull}@{sha}")) },
        body: review(action, event, 30),
    }
}

#[tokio::test]
async fn a_review_goes_out_once_with_its_marker_and_is_found_and_taken_back() {
    let rig = github().await;
    let channels = rig.service().channels();
    assert!(channels.get("mail").is_none());
    let github = channels.get("github").expect("the channel");
    let traits = github.traits("post_review").expect("traits");
    assert_eq!(
        (traits.idempotency, traits.undo, traits.undo_window_ms, traits.max_bytes),
        (Idempotency::Marker, Undo::Partial, 86_400_000, 65_536)
    );
    let approve = github.traits("approve_pull_request").expect("traits");
    assert_eq!((approve.class, approve.undo), (eos_contracts::ActionClass::Irreversible, Undo::None));
    assert!(github.traits("withdraw_review").is_none());

    let request = send("dl-1", "post_review", "COMMENT", 7, HEAD);
    assert_eq!(github.precondition(&request).await, Ok(Fresh::Fresh));
    assert_eq!(github.lookup("dl-1", &request.target).await, Ok(None), "nothing went out yet");
    let receipt = github.send(&request).await.expect("sends");
    let sent = rig.fake.reviews(REPO, 7);
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0]["body"], "Two notes.\n\n<!-- eos:d:dl-1 -->");
    assert_eq!(sent[0]["comments"][0]["line"], 30);
    assert_eq!(receipt.id, sent[0]["id"].to_string());
    assert_eq!(github.lookup("dl-1", &request.target).await, Ok(Some(receipt.clone())), "found by its marker");
    let again = github.send(&request).await.expect("sends");
    assert_eq!((again, rig.fake.reviews(REPO, 7).len()), (receipt.clone(), 1), "never twice");

    assert_eq!(github.undo(&receipt).await, Ok(UndoOutcome::Partial), "a sent review stays, its comments go");
    assert_eq!(rig.fake.reviews(REPO, 7)[0]["body"], "Withdrawn.");
}

#[tokio::test]
async fn a_review_a_crash_left_pending_is_submitted_not_sent_again() {
    let rig = github().await;
    let github = rig.service().channels().get("github").expect("the channel");
    let login = rig.fake.login();
    let left = rig.fake.add_review(REPO, 7, &login, "Two notes.\n\n<!-- eos:d:dl-7 -->", "PENDING");
    let request = send("dl-7", "post_review", "COMMENT", 7, HEAD);
    assert_eq!(github.lookup("dl-7", &request.target).await, Ok(None), "a pending review is not out");
    let receipt = github.send(&request).await.expect("sends");
    assert_eq!(receipt.id, left.to_string());
    let reviews = rig.fake.reviews(REPO, 7);
    assert_eq!((reviews.len(), reviews[0]["state"].as_str()), (1, Some("COMMENTED")));
    let pending = Receipt { id: left.to_string(), url: None };
    assert!(github.undo(&pending).await.is_err(), "a receipt without its link names no pull request");
}

#[tokio::test]
async fn githubs_refusals_read_as_what_they_mean() {
    let rig = github().await;
    let github = rig.service().channels().get("github").expect("the channel");
    let login = rig.fake.login();
    rig.fake.add_review(REPO, 7, &login, "My own notes.", "PENDING");
    let drafting = github.send(&send("dl-2", "post_review", "COMMENT", 7, HEAD)).await.expect_err("refused");
    assert_eq!(drafting.kind, SendErrorKind::UserDraftInProgress);
    assert_eq!(rig.fake.reviews(REPO, 7).len(), 1, "the user's draft is left alone");

    rig.fake.add_pull(REPO, 9, &login, "c9c9", 1_763_400_000_000, &[("src/main.rs", PATCH)]);
    let own = github.send(&send("dl-3", "approve_pull_request", "APPROVE", 9, "c9c9")).await.expect_err("refused");
    assert_eq!((own.kind, own.detail_kind.as_str()), (SendErrorKind::Permanent, "own_pull_request"));
    let changes = github.send(&send("dl-4", "post_review", "REQUEST_CHANGES", 9, "c9c9")).await.expect_err("refused");
    assert_eq!(changes.detail_kind, "own_pull_request");

    let moved = send("dl-5", "post_review", "COMMENT", 7, "an-older-head");
    assert_eq!(github.precondition(&moved).await, Ok(Fresh::Stale { reason: "new commits".into() }));
    let mut gone = send("dl-6", "post_review", "COMMENT", 70, HEAD);
    gone.target.place = Place::Item(format!("github:pr:{REPO}#70@{HEAD}"));
    assert_eq!(github.send(&gone).await.expect_err("refused").kind, SendErrorKind::NotFound);

    rig.fake.revoke();
    let signed_out = github.send(&send("dl-8", "post_review", "COMMENT", 7, HEAD)).await.expect_err("refused");
    assert_eq!(signed_out.kind, SendErrorKind::Auth);
}
