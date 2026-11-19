//! A GitHub pull request as routines name it, and a review result turned
//! into what the `github` channel sends. The one place the service knows
//! GitHub's shapes: its channel, its checkout and the check of a review.

use eos_contracts::{ItemRef, PrReview, PrReviewComment, ResultDoc};
use eos_domain::result_doc::{EVENT, GITHUB_REVIEW, SUMMARY};
use serde_json::Value;

/// The `github` built-in.
pub(crate) const GITHUB: &str = "github";
/// The kind of item a pull request is.
pub(crate) const PULL_REQUEST: &str = "github.pull_request";
const KEY_PREFIX: &str = "github:pr:";
const WEB: &str = "https://github.com/";

/// A pull request, and the head commit a result was made on when known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Pull {
    pub(crate) repo: String,
    pub(crate) number: u64,
    pub(crate) sha: Option<String>,
}

impl Pull {
    /// `github:pr:<owner>/<name>#<n>`, with `@<sha>` when the key names the
    /// version.
    pub(crate) fn from_key(key: &str) -> Option<Pull> {
        let rest = key.strip_prefix(KEY_PREFIX)?;
        let (place, sha) = match rest.split_once('@') {
            Some((place, sha)) => (place, Some(sha.to_owned()).filter(|sha| !sha.is_empty())),
            None => (rest, None),
        };
        let (repo, number) = place.split_once('#')?;
        Some(Pull { repo: repo.to_owned(), number: number.parse().ok()?, sha }).filter(|pull| pull.repo.contains('/'))
    }

    /// `https://github.com/<owner>/<name>/pull/<n>`, whatever follows.
    pub(crate) fn from_url(url: &str) -> Option<Pull> {
        let rest = url.strip_prefix(WEB)?;
        let mut parts = rest.split(['/', '#', '?']);
        let (owner, name, pull, number) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
        (pull == "pull").then_some(())?;
        Some(Pull { repo: format!("{owner}/{name}"), number: number.parse().ok()?, sha: None })
    }

    /// The pull request a run's item names: by its key, else its link; its
    /// version is the head it was read at.
    pub(crate) fn of_item(item: &ItemRef) -> Option<Pull> {
        let mut pull =
            item.key.as_deref().and_then(Pull::from_key).or_else(|| item.url.as_deref().and_then(Pull::from_url))?;
        if let Some(version) = item.version.clone().filter(|version| !version.is_empty()) {
            pull.sha = Some(version);
        }
        Some(pull)
    }

    /// The input naming the pull request: `{repo, number}`.
    pub(crate) fn input(&self) -> Value {
        serde_json::json!({ "repo": self.repo, "number": self.number })
    }
}

/// A review result as the input of the action that sends it, made on
/// `commit_id`; the text of what is wrong when it is no review.
pub(crate) fn review_of(doc: &ResultDoc, pull: &Pull, commit_id: &str) -> Result<PrReview, String> {
    if doc.kind != GITHUB_REVIEW {
        return Err(format!("a {} result is not a review", doc.kind));
    }
    let text = |key: &str| doc.parts.iter().find(|part| part.key == key).map(|part| part.text.clone());
    let event = text(EVENT).unwrap_or_else(|| "COMMENT".to_owned());
    let comments = doc
        .parts
        .iter()
        .filter(|part| part.key != EVENT && part.key != SUMMARY)
        .map(|part| {
            let meta = |field: &str| part.meta.get(field);
            let path = meta("path").and_then(Value::as_str).ok_or_else(|| format!("{} has no path", part.key))?;
            let line = meta("line").and_then(Value::as_u64).ok_or_else(|| format!("{} has no line", part.key))?;
            Ok(PrReviewComment {
                path: path.to_owned(),
                line,
                side: meta("side").and_then(Value::as_str).map(str::to_owned),
                start_line: meta("startLine").and_then(Value::as_u64),
                body: part.text.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(PrReview {
        repo: pull.repo.clone(),
        number: pull.number,
        commit_id: commit_id.to_owned(),
        event,
        body: text(SUMMARY).unwrap_or_default(),
        comments,
    })
}

/// What `action` takes of a review: an approval carries neither an event
/// nor line comments.
pub(crate) fn action_input(action: &str, review: &PrReview) -> Value {
    let mut input = serde_json::to_value(review).unwrap_or_default();
    if action == "approve_pull_request"
        && let Some(fields) = input.as_object_mut()
    {
        fields.remove("event");
        fields.remove("comments");
    }
    input
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pull_request_is_read_from_its_key_or_its_link() {
        let at = Pull::from_key("github:pr:acme/game#482@6dcb09b");
        assert_eq!(at, Some(Pull { repo: "acme/game".into(), number: 482, sha: Some("6dcb09b".into()) }));
        assert_eq!(Pull::from_key("github:pr:acme/game#482").and_then(|pull| pull.sha), None);
        assert_eq!(Pull::from_key("github:pr:acme#482"), None);
        assert_eq!(Pull::from_key("mail:thread:1"), None);
        let review = Pull::from_url("https://github.com/acme/game/pull/482#pullrequestreview-9");
        assert_eq!(review, Some(Pull { repo: "acme/game".into(), number: 482, sha: None }));
        assert_eq!(Pull::from_url("https://github.com/acme/game/issues/482"), None);
    }
}
