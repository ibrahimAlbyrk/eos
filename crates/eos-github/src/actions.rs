//! The read actions and the dispatch of every action to its code, with the
//! input checks the schema subset cannot say (a repository's name).

use eos_contracts::Issue;
use eos_core::capability::{ActionError, FailureKind};
use eos_domain::capability::schema::input_error;
use eos_domain::time::ms_from_iso;
use serde_json::{Value, json};

use crate::GitHub;
use crate::manifest::{ID, PULL_REQUEST};

/// The most files of a pull request read (GitHub lists at most 3,000).
pub(crate) const FILE_PAGES_MAX: u32 = 30;

/// A repository, `owner/name`, safe to put in a path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Repo(pub(crate) String);

fn plain(part: &str, extra: &[char]) -> bool {
    !part.is_empty()
        && part != "."
        && part != ".."
        && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || extra.contains(&c))
}

fn invalid(action: &str, field: &str, message: &str) -> ActionError {
    let issue = Issue { path: vec![field.to_owned()], message: message.to_owned() };
    ActionError::Invalid(input_error(ID, action, &[issue]))
}

pub(crate) fn repo(action: &str, input: &Value) -> Result<Repo, ActionError> {
    let text = input["repo"].as_str().unwrap_or_default();
    match text.split_once('/') {
        Some((owner, name)) if plain(owner, &[]) && plain(name, &['.', '_']) => Ok(Repo(text.to_owned())),
        _ => Err(invalid(action, "repo", "Expected owner/name")),
    }
}

pub(crate) fn number(input: &Value, field: &str) -> u64 {
    input[field].as_u64().unwrap_or_default()
}

pub(crate) fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value[field].as_str().unwrap_or_default()
}

/// A time GitHub wrote, in ms; 0 when it wrote none.
pub(crate) fn ms(value: &Value, field: &str) -> i64 {
    value[field].as_str().and_then(ms_from_iso).unwrap_or_default()
}

/// `github:pr:<owner>/<repo>#<n>`.
pub(crate) fn item_key(repo: &str, number: u64) -> String {
    format!("github:pr:{repo}#{number}")
}

fn login(user: &Value) -> String {
    text(user, "login").to_owned()
}

/// A pull request as the list and the source give it.
pub(crate) fn summary(pull: &Value) -> Value {
    json!({
        "number": pull["number"],
        "title": text(pull, "title"),
        "author": login(&pull["user"]),
        "url": text(pull, "html_url"),
        "state": text(pull, "state"),
        "draft": pull["draft"].as_bool().unwrap_or(false),
        "headSha": text(&pull["head"], "sha"),
        "base": text(&pull["base"], "ref"),
        "updatedAt": ms(pull, "updated_at"),
    })
}

pub(crate) fn labels(pull: &Value) -> Vec<String> {
    let labels = pull["labels"].as_array().into_iter().flatten();
    labels.filter_map(|label| label["name"].as_str().map(str::to_owned)).collect()
}

impl GitHub {
    pub(crate) async fn run(
        &self,
        action: &str,
        input: Value,
        token: &str,
        key: Option<&str>,
    ) -> Result<Value, ActionError> {
        match action {
            "check" => self.check(token).await,
            "list_pull_requests" => self.list_pull_requests(token, &input).await,
            "get_pull_request" => self.get_pull_request(token, &input).await,
            "get_pull_request_files" => {
                let repo = repo(action, &input)?;
                let files = self.files(token, &repo, number(&input, "number")).await?;
                Ok(json!({ "files": files.iter().map(file_out).collect::<Vec<_>>() }))
            }
            "post_review" => self.post_review(token, &input, key).await,
            "withdraw_review" => self.withdraw_review(token, &input).await,
            "find_review" => self.find_review(token, &input).await,
            "approve_pull_request" => self.approve(token, &input, key).await,
            "poll_pull_requests" => self.poll(token, &input).await,
            "find_pull_requests" => self.find(token, &input).await,
            _ => Err(ActionError::NotFound),
        }
    }

    /// The sign-in works and may read private repositories.
    pub(crate) async fn check(&self, token: &str) -> Result<Value, ActionError> {
        let response = self.request(token, crate::Method::Get, "/user", None, &[]).await?;
        let scopes = response.header("x-oauth-scopes").unwrap_or_default();
        if scopes.split(',').any(|scope| scope.trim() == "repo") {
            Ok(json!({ "ok": true }))
        } else {
            // Signed in without the scope reviews need: signing in again asks for it.
            Err(ActionError::Failed { kind: FailureKind::Unauthorized })
        }
    }

    async fn list_pull_requests(&self, token: &str, input: &Value) -> Result<Value, ActionError> {
        let repo = repo("list_pull_requests", input)?;
        let state = input["state"].as_str().unwrap_or("open");
        let limit = input["limit"].as_u64().unwrap_or(30);
        let path = format!("/repos/{}/pulls?state={state}&sort=updated&direction=desc&per_page={limit}", repo.0);
        let pulls = self.get(token, &path).await?;
        let pulls = pulls.as_array().ok_or(ActionError::Failed { kind: FailureKind::Service })?;
        Ok(json!({ "pullRequests": pulls.iter().map(summary).collect::<Vec<_>>() }))
    }

    pub(crate) async fn pull(&self, token: &str, repo: &Repo, number: u64) -> Result<Value, ActionError> {
        self.get(token, &format!("/repos/{}/pulls/{number}", repo.0)).await
    }

    async fn get_pull_request(&self, token: &str, input: &Value) -> Result<Value, ActionError> {
        let repo = repo("get_pull_request", input)?;
        let number = number(input, "number");
        let pull = self.pull(token, &repo, number).await?;
        let files = self.files(token, &repo, number).await?;
        Ok(json!({
            "number": pull["number"],
            "title": text(&pull, "title"),
            "body": text(&pull, "body"),
            "author": login(&pull["user"]),
            "url": text(&pull, "html_url"),
            "state": text(&pull, "state"),
            "draft": pull["draft"].as_bool().unwrap_or(false),
            "headSha": text(&pull["head"], "sha"),
            "base": text(&pull["base"], "ref"),
            "labels": labels(&pull),
            "files": files.iter().map(|file| text(file, "filename")).collect::<Vec<_>>(),
        }))
    }

    /// Every file the pull request changes, as GitHub lists them.
    pub(crate) async fn files(&self, token: &str, repo: &Repo, number: u64) -> Result<Vec<Value>, ActionError> {
        let mut files = Vec::new();
        for page in 1..=FILE_PAGES_MAX {
            let path = format!("/repos/{}/pulls/{number}/files?per_page=100&page={page}", repo.0);
            let listed = self.get(token, &path).await?;
            let listed = listed.as_array().ok_or(ActionError::Failed { kind: FailureKind::Service })?;
            files.extend(listed.iter().cloned());
            if listed.len() < 100 {
                break;
            }
        }
        Ok(files)
    }

    /// Pull requests, newest first, through GitHub's search: of `repo` when
    /// given, else those that involve the user; open unless `state` says
    /// `closed` or `all`; narrowed by `q`.
    async fn find(&self, token: &str, input: &Value) -> Result<Value, ActionError> {
        let limit = input["limit"].as_u64().unwrap_or(30);
        let whose = if input["repo"].is_string() {
            format!("repo:{}", repo("find_pull_requests", input)?.0)
        } else {
            "involves:@me".to_owned()
        };
        let state = match text(input, "state") {
            "all" => "",
            "closed" => "is:closed",
            _ => "is:open",
        };
        let query =
            format!("is:pr {state} {whose} {}", text(input, "q")).split_whitespace().collect::<Vec<_>>().join(" ");
        let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
        let path = format!("/search/issues?q={encoded}&sort=updated&order=desc&per_page={limit}");
        let found = self.get(token, &path).await?;
        let items = found["items"].as_array().into_iter().flatten().filter_map(|issue| {
            let repo = text(issue, "repository_url").strip_prefix(&format!("{}/repos/", crate::API))?.to_owned();
            let number = issue["number"].as_u64()?;
            Some(json!({
                "key": item_key(&repo, number),
                "kind": PULL_REQUEST,
                "title": text(issue, "title"),
                "url": text(issue, "html_url"),
                "updatedAt": ms(issue, "updated_at"),
                "data": { "repo": repo, "number": number, "author": login(&issue["user"]),
                          "draft": issue["draft"].as_bool().unwrap_or(false) },
            }))
        });
        Ok(json!({ "items": items.collect::<Vec<_>>() }))
    }
}

fn file_out(file: &Value) -> Value {
    json!({
        "path": text(file, "filename"),
        "status": text(file, "status"),
        "additions": file["additions"].as_u64().unwrap_or_default(),
        "deletions": file["deletions"].as_u64().unwrap_or_default(),
        "patch": text(file, "patch"),
    })
}
