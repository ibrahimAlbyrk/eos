//! GitHub in memory, behind `eos_github::Transport`: the device flow, the
//! signed-in user, pull requests with their files, reviews with the rules
//! GitHub keeps (one pending review per user, nothing outside the diff, no
//! approving one's own pull request), conditional list requests and rate
//! limits. Bodies follow GitHub's documented shapes; requests are recorded
//! without their token.

mod reviews;

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Mutex, MutexGuard};

use eos_core::BoxFuture;
use eos_domain::time::iso_from_ms;
use eos_github::{HttpRequest, HttpResponse, Method, Transport};
use serde_json::{Value, json};

/// The token GitHub hands out and accepts.
pub const GITHUB_TOKEN: &str = "gho_fake_github_token_1";
/// What the device flow shows the user.
pub const GITHUB_USER_CODE: &str = "WDJB-MJHT";
/// What the device flow polls with.
pub const GITHUB_DEVICE_CODE: &str = "3584d83530557fdd1f46af8289938c8ef79f9dc5";

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// `2026-11-18T10:00:00Z`, as GitHub writes a time.
fn time(ms: i64) -> String {
    format!("{}Z", &iso_from_ms(ms)[..19])
}

/// One request the fake took: the path with its query, the JSON or form
/// body, and whether it carried the token GitHub accepts.
#[derive(Debug, Clone, PartialEq)]
pub struct GitHubCall {
    pub method: Method,
    pub path: String,
    pub body: Value,
    pub signed_in: bool,
}

#[derive(Debug, Clone)]
struct Pull {
    json: Value,
    files: Vec<Value>,
}

#[derive(Debug, Clone)]
struct Review {
    repo: String,
    number: u64,
    json: Value,
    comments: Vec<Value>,
}

#[derive(Debug)]
struct State {
    login: String,
    scopes: String,
    token_valid: bool,
    device: VecDeque<Value>,
    device_interval_s: u64,
    pulls: BTreeMap<(String, u64), Pull>,
    reviews: Vec<Review>,
    next_id: u64,
    /// Bumped by every change to a pull request: the list's ETag.
    version: u64,
    poll_interval_s: u64,
    limited: Option<HttpResponse>,
    hung: bool,
    dismissals_refused: bool,
    /// Repository webhooks, as created: `(repo, body)`.
    hooks: Vec<(String, Value)>,
    /// Repositories where the user is no admin: creating a webhook is 404.
    not_admin: Vec<String>,
    calls: Vec<GitHubCall>,
}

#[derive(Debug)]
pub struct FakeGitHub(Mutex<State>);

impl Default for FakeGitHub {
    fn default() -> Self {
        Self::new()
    }
}

fn answer(status: u16, body: &Value) -> HttpResponse {
    let headers = vec![("content-type".to_owned(), "application/json; charset=utf-8".to_owned())];
    HttpResponse { status, headers, body: body.to_string().into_bytes() }
}

fn unprocessable(phrase: &str) -> HttpResponse {
    let body = json!({
        "message": "Unprocessable Entity",
        "errors": [phrase],
        "documentation_url": "https://docs.github.com/rest/pulls/reviews#create-a-review-for-a-pull-request",
        "status": "422",
    });
    answer(422, &body)
}

fn not_found() -> HttpResponse {
    answer(
        404,
        &json!({ "message": "Not Found", "documentation_url": "https://docs.github.com/rest", "status": "404" }),
    )
}

fn user(login: &str) -> Value {
    json!({ "login": login, "id": 583231, "node_id": "MDQ6VXNlcjU4MzIzMQ==", "type": "User", "site_admin": false })
}

impl FakeGitHub {
    /// Signed in as `monalisa-octo` with the `repo` scope; no pull requests yet.
    pub fn new() -> Self {
        Self(Mutex::new(State {
            login: "monalisa-octo".to_owned(),
            scopes: "repo, read:org".to_owned(),
            token_valid: true,
            device: VecDeque::new(),
            device_interval_s: 5,
            pulls: BTreeMap::new(),
            reviews: Vec::new(),
            next_id: 80,
            version: 1,
            poll_interval_s: 60,
            limited: None,
            hung: false,
            dismissals_refused: false,
            hooks: Vec::new(),
            not_admin: Vec::new(),
            calls: Vec::new(),
        }))
    }

    /// The signed-in user's login.
    pub fn login(&self) -> String {
        locked(&self.0).login.clone()
    }

    pub fn set_scopes(&self, scopes: &str) {
        locked(&self.0).scopes = scopes.to_owned();
    }

    /// The token stops working: every API call answers 401.
    pub fn revoke(&self) {
        locked(&self.0).token_valid = false;
    }

    /// What the next token polls answer, in order (`{"error":
    /// "slow_down"}`, `{"access_token": …}`); `authorization_pending` once
    /// they are used up.
    pub fn device_answers(&self, answers: Vec<Value>) {
        locked(&self.0).device = answers.into();
    }

    /// GitHub asks for this long between token polls (5 s until then).
    pub fn set_device_interval(&self, seconds: u64) {
        locked(&self.0).device_interval_s = seconds;
    }

    /// The answer a token poll gives once the user entered the code.
    pub fn granted() -> Value {
        json!({ "access_token": GITHUB_TOKEN, "token_type": "bearer", "scope": "repo" })
    }

    /// The next request is answered with this rate-limit refusal.
    pub fn limit_next(&self, status: u16, headers: &[(&str, &str)]) {
        let headers = headers.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())).collect();
        let body = json!({ "message": "API rate limit exceeded", "documentation_url": "https://docs.github.com/rest" });
        locked(&self.0).limited = Some(HttpResponse { status, headers, body: body.to_string().into_bytes() });
    }

    /// Requests are taken and never answered.
    pub fn hang(&self) {
        locked(&self.0).hung = true;
    }

    /// Dismissing a review needs rights the user lacks (a protected branch).
    pub fn refuse_dismissals(&self) {
        locked(&self.0).dismissals_refused = true;
    }

    /// GitHub's list asks clients to poll no sooner than this.
    pub fn set_poll_interval(&self, seconds: u64) {
        locked(&self.0).poll_interval_s = seconds;
    }

    /// A pull request of `repo` by `author` at head `sha`, created and
    /// updated at `at`; each file is `(path, patch)`.
    pub fn add_pull(&self, repo: &str, number: u64, author: &str, sha: &str, at: i64, files: &[(&str, &str)]) {
        let json = json!({
            "url": format!("https://api.github.com/repos/{repo}/pulls/{number}"),
            "id": 1_000_000 + number,
            "node_id": "PR_kwDOAJy2Ks4",
            "html_url": format!("https://github.com/{repo}/pull/{number}"),
            "number": number,
            "state": "open",
            "locked": false,
            "title": format!("Change {number}"),
            "user": user(author),
            "body": "Please review.",
            "labels": [],
            "created_at": time(at),
            "updated_at": time(at),
            "closed_at": null,
            "merged_at": null,
            "draft": false,
            "head": { "label": format!("{author}:topic-{number}"), "ref": format!("topic-{number}"), "sha": sha },
            "base": { "label": "acme:main", "ref": "main", "sha": "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0" },
            "author_association": "MEMBER",
        });
        let files = files
            .iter()
            .map(|(path, patch)| {
                let additions = patch.lines().filter(|line| line.starts_with('+')).count();
                let deletions = patch.lines().filter(|line| line.starts_with('-')).count();
                json!({
                    "sha": "bbcd538c8e72b8c175046e27cc8f907076331401", "filename": path, "status": "modified",
                    "additions": additions, "deletions": deletions, "changes": additions + deletions,
                    "blob_url": format!("https://github.com/{repo}/blob/{sha}/{path}"), "patch": patch,
                })
            })
            .collect();
        let mut state = locked(&self.0);
        state.pulls.insert((repo.to_owned(), number), Pull { json, files });
        state.version += 1;
    }

    /// Changes a pull request's fields (`state`, `draft`, `title`, `labels`,
    /// `head`) and moves its `updated_at` to `at`.
    pub fn update_pull(&self, repo: &str, number: u64, at: i64, fields: Value) {
        let mut state = locked(&self.0);
        if let Some(pull) = state.pulls.get_mut(&(repo.to_owned(), number)) {
            for (key, value) in fields.as_object().into_iter().flatten() {
                pull.json[key] = value.clone();
            }
            pull.json["updated_at"] = time(at).into();
        }
        state.version += 1;
    }

    /// The webhooks created on `repo`, as their requests' bodies.
    pub fn webhooks(&self, repo: &str) -> Vec<Value> {
        locked(&self.0).hooks.iter().filter(|(r, _)| r == repo).map(|(_, body)| body.clone()).collect()
    }

    /// The user is no admin of `repo`: GitHub answers a webhook's creation 404.
    pub fn not_admin(&self, repo: &str) {
        locked(&self.0).not_admin.push(repo.to_owned());
    }

    /// Every request taken, in order.
    pub fn calls(&self) -> Vec<GitHubCall> {
        locked(&self.0).calls.clone()
    }

    fn route(&self, request: &HttpRequest, body: &Value) -> Option<HttpResponse> {
        let mut state = locked(&self.0);
        if let Some(limited) = state.limited.take() {
            return Some(limited);
        }
        let url = request.url.as_str();
        if let Some(path) = url.strip_prefix("https://github.com") {
            return Some(state.device_flow(path));
        }
        let path = url.strip_prefix("https://api.github.com")?;
        if request.header("authorization") != Some(&format!("Bearer {GITHUB_TOKEN}")) || !state.token_valid {
            let body = json!({ "message": "Bad credentials", "documentation_url": "https://docs.github.com/rest", "status": "401" });
            return Some(answer(401, &body));
        }
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let response = match (request.method, parts.as_slice()) {
            (Method::Get, ["user"]) => {
                let mut response = answer(200, &user(&state.login));
                response.headers.push(("x-oauth-scopes".to_owned(), state.scopes.clone()));
                response
            }
            (Method::Get, ["search", "issues"]) => state.search(),
            (Method::Get, ["repos", owner, name, "pulls"]) => state.list(&format!("{owner}/{name}"), request),
            (Method::Get, ["repos", owner, name, "pulls", number]) => {
                let pull = state.pulls.get(&(format!("{owner}/{name}"), number.parse().ok()?));
                pull.map_or_else(not_found, |pull| answer(200, &pull.json))
            }
            (Method::Get, ["repos", owner, name, "pulls", number, "files"]) => {
                let pull = state.pulls.get(&(format!("{owner}/{name}"), number.parse().ok()?));
                // One page, as GitHub lists them: `per_page` from `page` (from 1); all without `per_page`.
                let param = |name: &str| {
                    query.split('&').find_map(|pair| pair.strip_prefix(name)?.strip_prefix('=')?.parse::<usize>().ok())
                };
                let (per_page, page) = (param("per_page"), param("page").unwrap_or(1).max(1));
                pull.map_or_else(not_found, |pull| {
                    let per_page = per_page.unwrap_or(pull.files.len().max(1));
                    let shown: Vec<Value> =
                        pull.files.iter().skip(per_page * (page - 1)).take(per_page).cloned().collect();
                    answer(200, &json!(shown))
                })
            }
            // The files of the repository's first pull request: a test compares one.
            (Method::Get, ["repos", owner, name, "compare", _]) => {
                let repo = format!("{owner}/{name}");
                let pull = state.pulls.iter().find(|((r, _), _)| *r == repo).map(|(_, pull)| pull);
                pull.map_or_else(not_found, |pull| answer(200, &json!({ "status": "ahead", "files": pull.files })))
            }
            (Method::Post, ["repos", owner, name, "hooks"]) => {
                let repo = format!("{owner}/{name}");
                if state.not_admin.contains(&repo) {
                    not_found()
                } else {
                    state.next_id += 1;
                    let id = state.next_id;
                    state.hooks.push((repo, body.clone()));
                    answer(201, &json!({ "id": id, "type": "Repository", "active": true, "events": body["events"] }))
                }
            }
            (method, ["repos", owner, name, "pulls", rest @ ..]) => {
                state.review_route(method, &format!("{owner}/{name}"), rest, query, body)
            }
            _ => not_found(),
        };
        Some(response)
    }
}

impl State {
    fn device_flow(&mut self, path: &str) -> HttpResponse {
        match path {
            "/login/device/code" => answer(
                200,
                &json!({
                    "device_code": GITHUB_DEVICE_CODE,
                    "user_code": GITHUB_USER_CODE,
                    "verification_uri": "https://github.com/login/device",
                    "expires_in": 900,
                    "interval": self.device_interval_s,
                }),
            ),
            "/login/oauth/access_token" => {
                let next = self.device.pop_front().unwrap_or_else(|| json!({ "error": "authorization_pending" }));
                answer(200, &next)
            }
            _ => not_found(),
        }
    }

    /// The repository's pull requests, most recently updated first, with
    /// the ETag of this version of the list: the same ETag back is a 304.
    fn list(&self, repo: &str, request: &HttpRequest) -> HttpResponse {
        let etag = format!("W/\"{:x}\"", self.version * 7919);
        let mut response = if request.header("if-none-match") == Some(etag.as_str()) {
            HttpResponse { status: 304, ..HttpResponse::default() }
        } else {
            let mut pulls: Vec<&Value> =
                self.pulls.iter().filter(|((r, _), _)| r == repo).map(|(_, pull)| &pull.json).collect();
            pulls.sort_by(|a, b| b["updated_at"].as_str().cmp(&a["updated_at"].as_str()));
            answer(200, &json!(pulls))
        };
        response.headers.push(("etag".to_owned(), etag));
        response.headers.push(("x-poll-interval".to_owned(), self.poll_interval_s.to_string()));
        response
    }

    /// Open pull requests, as the search API answers them.
    fn search(&self) -> HttpResponse {
        let items: Vec<Value> = self
            .pulls
            .iter()
            .filter(|(_, pull)| pull.json["state"] == "open")
            .map(|((repo, number), pull)| {
                json!({
                    "url": format!("https://api.github.com/repos/{repo}/issues/{number}"),
                    "repository_url": format!("https://api.github.com/repos/{repo}"),
                    "html_url": pull.json["html_url"],
                    "number": number,
                    "state": "open",
                    "title": pull.json["title"],
                    "user": pull.json["user"],
                    "draft": pull.json["draft"],
                    "updated_at": pull.json["updated_at"],
                    "pull_request": { "url": pull.json["url"], "html_url": pull.json["html_url"] },
                })
            })
            .collect();
        answer(200, &json!({ "total_count": items.len(), "incomplete_results": false, "items": items }))
    }
}

impl Transport for FakeGitHub {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, eos_github::Error>> {
        let raw = request.body.clone().unwrap_or_default();
        let body = serde_json::from_slice(&raw).unwrap_or_else(|_| {
            let form = url::form_urlencoded::parse(&raw).into_owned().collect::<BTreeMap<String, String>>();
            json!(form)
        });
        let path = request.url.split_once(".com").map_or(request.url.as_str(), |(_, path)| path).to_owned();
        let signed_in = request.header("authorization") == Some(&format!("Bearer {GITHUB_TOKEN}"));
        let hung = {
            let mut state = locked(&self.0);
            state.calls.push(GitHubCall { method: request.method, path, body: body.clone(), signed_in });
            state.hung
        };
        if hung {
            return Box::pin(std::future::pending());
        }
        let response = self.route(&request, &body).unwrap_or_else(not_found);
        Box::pin(std::future::ready(Ok(response)))
    }
}
