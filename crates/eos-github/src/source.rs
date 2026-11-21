//! The `pulls` source: what changed in a repository's pull requests since
//! the cursor. The cursor is the caller's to keep and hand back: the ETag of
//! the last page (a conditional request answered 304 costs nothing), the
//! newest update seen with the pull requests seen at that time (GitHub's
//! times are whole seconds, and another change may land in the same one),
//! and the drafts still open, so a draft made ready reads as `ready`. A first poll, with no cursor, only sets the baseline:
//! what exists already is not news.

use std::collections::BTreeSet;

use eos_core::capability::{ActionError, FailureKind};
use serde_json::{Value, json};

use crate::GitHub;
use crate::actions::{FILE_PAGES_MAX, Repo, item_key, labels, ms, repo, summary, text};
use crate::client::Method;

/// The pull requests one poll reads, most recently updated first.
const PAGE: u32 = 50;
/// How long to wait between polls when GitHub names no interval.
const POLL_AFTER_S: u64 = 60;
/// The most drafts the cursor remembers.
const DRAFTS_MAX: usize = 100;

/// The numbers in the cursor's list `field`.
fn numbers(cursor: &Value, field: &str) -> BTreeSet<u64> {
    cursor[field].as_array().into_iter().flatten().filter_map(Value::as_u64).collect()
}

/// Whether a time `pull` wrote in `field` is after the cursor: after
/// `since`, or at it for a pull request not seen then.
fn after(pull: &Value, field: &str, since: i64, seen: &BTreeSet<u64>) -> bool {
    let at = ms(pull, field);
    at > since || (at == since && pull["number"].as_u64().is_some_and(|number| !seen.contains(&number)))
}

/// What happened to `pull` since `since`.
fn event(pull: &Value, since: i64, seen: &BTreeSet<u64>, drafts: &BTreeSet<u64>) -> &'static str {
    let draft = pull["draft"].as_bool().unwrap_or(false);
    if text(pull, "state") == "closed" {
        "closed"
    } else if after(pull, "created_at", since, seen) {
        "opened"
    } else if !draft && pull["number"].as_u64().is_some_and(|number| drafts.contains(&number)) {
        "ready"
    } else {
        "updated"
    }
}

impl GitHub {
    pub(crate) async fn poll(&self, token: &str, input: &Value) -> Result<Value, ActionError> {
        let repo = repo("poll_pull_requests", input)?;
        let cursor = &input["cursor"];
        let baseline = cursor.is_null();
        let since = cursor["since"].as_i64().unwrap_or_default();
        let seen = numbers(cursor, "atSince");
        let known = numbers(cursor, "drafts");
        let path = format!("/repos/{}/pulls?state=all&sort=updated&direction=desc&per_page={PAGE}", repo.0);
        let etag = text(cursor, "etag");
        let condition = [("if-none-match", etag)];
        let extra: &[(&str, &str)] = if etag.is_empty() { &[] } else { &condition };
        let response = self.request(token, Method::Get, &path, None, extra).await?;
        let poll_after_s = response
            .header("x-poll-interval")
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(POLL_AFTER_S);
        if response.status == 304 {
            return Ok(json!({ "items": [], "cursor": cursor, "pollAfterS": poll_after_s, "baseline": false }));
        }
        let page = response.json()?;
        let pulls = page.as_array().ok_or(ActionError::Failed { kind: FailureKind::Service })?;
        let mut items = Vec::new();
        if !baseline {
            for pull in pulls.iter().rev().filter(|pull| after(pull, "updated_at", since, &seen)) {
                items.push(self.item(token, &repo, pull, event(pull, since, &seen, &known)).await?);
            }
        }
        let on_page: BTreeSet<u64> = pulls.iter().filter_map(|pull| pull["number"].as_u64()).collect();
        let open_drafts =
            pulls.iter().filter(|pull| pull["draft"].as_bool().unwrap_or(false) && text(pull, "state") == "open");
        let mut drafts: Vec<u64> = open_drafts.filter_map(|pull| pull["number"].as_u64()).collect();
        drafts.extend(known.iter().filter(|number| !on_page.contains(number)));
        drafts.truncate(DRAFTS_MAX);
        let newest = pulls.iter().map(|pull| ms(pull, "updated_at")).max().unwrap_or(since).max(since);
        let mut at_newest: BTreeSet<u64> = if newest == since { seen } else { BTreeSet::new() };
        let newest_on_page = pulls.iter().filter(|pull| ms(pull, "updated_at") == newest);
        at_newest.extend(newest_on_page.filter_map(|pull| pull["number"].as_u64()));
        let etag = response.header("etag").unwrap_or_default();
        let next = json!({ "etag": etag, "since": newest, "atSince": at_newest, "drafts": drafts });
        Ok(json!({ "items": items, "cursor": next, "pollAfterS": poll_after_s, "baseline": baseline }))
    }

    /// One changed pull request with the facts rules test; its files give
    /// the paths and the size. A list cut at the page cap names neither: the
    /// author chooses the files, and a fact that is missing passes no rule.
    async fn item(&self, token: &str, repo: &Repo, pull: &Value, event: &str) -> Result<Value, ActionError> {
        let number = pull["number"].as_u64().unwrap_or_default();
        let files = self.files(token, repo, number).await?;
        let cut = files.len() >= FILE_PAGES_MAX as usize * 100;
        let size: u64 = files
            .iter()
            .map(|file| file["additions"].as_u64().unwrap_or_default() + file["deletions"].as_u64().unwrap_or_default())
            .sum();
        let summary = summary(pull);
        let mut item = json!({
            "key": item_key(&repo.0, number),
            "version": summary["headSha"],
            "event": event,
            "title": summary["title"],
            "url": summary["url"],
            "updatedAt": summary["updatedAt"],
            "facts": {
                "repo": repo.0,
                "author": summary["author"],
                "labels": labels(pull),
                "paths": files.iter().map(|file| text(file, "filename")).collect::<Vec<_>>(),
                "draft": summary["draft"],
                "base": summary["base"],
                "size": size,
            },
        });
        if cut {
            if let Some(facts) = item["facts"].as_object_mut() {
                facts.remove("paths");
                facts.remove("size");
            }
        }
        Ok(item)
    }
}
