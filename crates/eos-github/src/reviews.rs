//! Reviews: posting one as a single request, approving, and taking one back
//! (06 G5, G18 to G20; 03 G18, G19).
//!
//! GitHub has no idempotency key for a review, so with a key the body ends
//! with `<!-- eos:d:<key> -->` and the user's reviews on the pull request are
//! read first: a review carrying the marker is the receipt (a pending one is
//! submitted first), and a pending review of the user's own is left alone
//! and refused as `user_draft_in_progress`. A submitted review cannot be
//! deleted, so taking one back deletes its line comments, replaces its text
//! and dismisses it when it asked for changes.

use eos_core::capability::{ActionError, FailureKind};
use serde_json::{Value, json};

use crate::GitHub;
use crate::actions::{Repo, number, repo, text};
use crate::client::Method;
use crate::diff::{self, DiffLines};

/// What a withdrawn review says.
const WITHDRAWN: &str = "Withdrawn.";

/// The end of a review Eos sent for the delivery with `key`.
pub(crate) fn marker(key: &str) -> String {
    format!("<!-- eos:d:{key} -->")
}

/// What a review to send says.
struct Draft<'a> {
    commit_id: &'a str,
    event: &'a str,
    text: &'a str,
    comments: &'a [Value],
}

fn receipt(review: &Value, stale: bool, notes: usize, already: bool) -> Value {
    json!({
        "reviewId": review["id"],
        "url": text(review, "html_url"),
        "state": text(review, "state"),
        "stale": stale,
        "notesOnOtherLines": notes,
        "alreadyPosted": already,
    })
}

fn service_failed() -> ActionError {
    ActionError::Failed { kind: FailureKind::Service }
}

impl GitHub {
    pub(crate) async fn post_review(
        &self,
        token: &str,
        input: &Value,
        key: Option<&str>,
    ) -> Result<Value, ActionError> {
        let repo = repo("post_review", input)?;
        let comments = input["comments"].as_array().map_or(&[][..], Vec::as_slice);
        let draft = Draft {
            commit_id: text(input, "commitId"),
            event: text(input, "event"),
            text: text(input, "body"),
            comments,
        };
        self.review(token, &repo, number(input, "number"), draft, key).await
    }

    pub(crate) async fn approve(&self, token: &str, input: &Value, key: Option<&str>) -> Result<Value, ActionError> {
        let repo = repo("approve_pull_request", input)?;
        let draft =
            Draft { commit_id: text(input, "commitId"), event: "APPROVE", text: text(input, "body"), comments: &[] };
        self.review(token, &repo, number(input, "number"), draft, key).await
    }

    async fn review(
        &self,
        token: &str,
        repo: &Repo,
        number: u64,
        draft: Draft<'_>,
        key: Option<&str>,
    ) -> Result<Value, ActionError> {
        let pull = self.pull(token, repo, number).await?;
        let stale = text(&pull["head"], "sha") != draft.commit_id;
        let marker = key.map(marker);
        if let Some(marker) = &marker
            && let Some(found) = self.sent_before(token, repo, number, marker, draft.event, stale).await?
        {
            return Ok(found);
        }
        let (placed, notes) = if draft.comments.is_empty() {
            (Vec::new(), Vec::new())
        } else {
            let files = if stale {
                self.compared(token, repo, text(&pull["base"], "sha"), draft.commit_id).await?
            } else {
                self.files(token, repo, number).await?
            };
            diff::place(draft.comments, &DiffLines::of(&files))
        };
        let mut request = json!({
            "commit_id": draft.commit_id,
            "body": diff::body(draft.text, &notes, marker.as_deref()),
            "event": draft.event,
        });
        if !placed.is_empty() {
            request["comments"] = Value::Array(placed);
        }
        let path = format!("/repos/{}/pulls/{number}/reviews", repo.0);
        let review = self.send_json(token, Method::Post, &path, request).await?;
        Ok(receipt(&review, stale, notes.len(), false))
    }

    /// The receipt of a review sent before with `marker`, submitting it with
    /// `event` when a crash left it pending; `None` when there is none.
    async fn sent_before(
        &self,
        token: &str,
        repo: &Repo,
        number: u64,
        marker: &str,
        event: &str,
        stale: bool,
    ) -> Result<Option<Value>, ActionError> {
        let mine = self.my_reviews(token, repo, number).await?;
        if let Some(review) = mine.iter().find(|review| text(review, "body").contains(marker)) {
            if text(review, "state") != "PENDING" {
                return Ok(Some(receipt(review, stale, 0, true)));
            }
            let path = format!("/repos/{}/pulls/{number}/reviews/{}/events", repo.0, review["id"]);
            let submitted = self.send_json(token, Method::Post, &path, json!({ "event": event })).await?;
            return Ok(Some(receipt(&submitted, stale, 0, true)));
        }
        if mine.iter().any(|review| text(review, "state") == "PENDING") {
            return Err(ActionError::Failed { kind: FailureKind::UserDraftInProgress });
        }
        Ok(None)
    }

    /// The signed-in user's reviews on the pull request, drafts included.
    async fn my_reviews(&self, token: &str, repo: &Repo, number: u64) -> Result<Vec<Value>, ActionError> {
        let me = self.get(token, "/user").await?;
        let me = text(&me, "login");
        let path = format!("/repos/{}/pulls/{number}/reviews?per_page=100", repo.0);
        let reviews = self.get(token, &path).await?;
        let reviews = reviews.as_array().ok_or_else(service_failed)?;
        Ok(reviews.iter().filter(|review| text(&review["user"], "login") == me).cloned().collect())
    }

    /// The user's review that carries the marker of the delivery `key`,
    /// pending or sent; reads only.
    pub(crate) async fn find_review(&self, token: &str, input: &Value) -> Result<Value, ActionError> {
        let repo = repo("find_review", input)?;
        let marker = marker(text(input, "key"));
        let mine = self.my_reviews(token, &repo, number(input, "number")).await?;
        Ok(match mine.iter().find(|review| text(review, "body").contains(&marker)) {
            Some(review) => {
                json!({ "found": true, "reviewId": review["id"], "url": text(review, "html_url"), "state": text(review, "state") })
            }
            None => json!({ "found": false }),
        })
    }

    /// The files of the diff the pull request had at `commit`.
    async fn compared(&self, token: &str, repo: &Repo, base: &str, commit: &str) -> Result<Vec<Value>, ActionError> {
        let compare = self.get(token, &format!("/repos/{}/compare/{base}...{commit}", repo.0)).await?;
        Ok(compare["files"].as_array().cloned().unwrap_or_default())
    }

    pub(crate) async fn withdraw_review(&self, token: &str, input: &Value) -> Result<Value, ActionError> {
        let repo = repo("withdraw_review", input)?;
        let reviews =
            format!("/repos/{}/pulls/{}/reviews/{}", repo.0, number(input, "number"), number(input, "reviewId"));
        let review = self.get(token, &reviews).await?;
        let state = text(&review, "state");
        if state == "PENDING" {
            self.delete(token, &reviews).await?;
            return Ok(json!({ "commentsDeleted": 0, "deleted": true, "dismissal": "not_needed" }));
        }
        let comments = self.get(token, &format!("{reviews}/comments?per_page=100")).await?;
        let comments = comments.as_array().ok_or_else(service_failed)?;
        for comment in comments {
            self.delete(token, &format!("/repos/{}/pulls/comments/{}", repo.0, comment["id"])).await?;
        }
        self.send_json(token, Method::Put, &reviews, json!({ "body": WITHDRAWN })).await?;
        let dismissal = if state != "CHANGES_REQUESTED" {
            "not_needed"
        } else {
            let dismissed = json!({ "message": WITHDRAWN, "event": "DISMISS" });
            // Dismissing may need an admin on a protected branch: the receipt says so.
            match self.send_json(token, Method::Put, &format!("{reviews}/dismissals"), dismissed).await {
                Ok(_) => "done",
                Err(_) => "failed",
            }
        };
        Ok(json!({ "commentsDeleted": comments.len(), "deleted": false, "dismissal": dismissal }))
    }
}
