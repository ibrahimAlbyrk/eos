//! Reviews as GitHub keeps them, with the refusals the review spike saw
//! (`research` findings of PH-03): a second pending review, a comment
//! outside the diff, the author approving or requesting changes.

use eos_github::{HttpResponse, Method};
use serde_json::{Value, json};

use super::{FakeGitHub, Review, State, answer, locked, not_found, unprocessable, user};

/// The lines of `patch` a comment on `side` can sit on.
fn lines(patch: &str, side: &str) -> Vec<u64> {
    let (mut old, mut new, mut shown) = (0, 0, Vec::new());
    for line in patch.lines() {
        if let Some(rest) = line.strip_prefix("@@ -") {
            let start = |range: &str| range.split(',').next().and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
            let (o, rest) = rest.split_once(" +").unwrap_or((rest, "0"));
            (old, new) = (start(o), start(rest.split(' ').next().unwrap_or("0")));
            continue;
        }
        let (on_left, on_right) = match line.chars().next() {
            Some('+') => (false, true),
            Some('-') => (true, false),
            Some('\\') => continue,
            _ => (true, true),
        };
        if side == "LEFT" && on_left {
            shown.push(old);
        }
        if side != "LEFT" && on_right {
            shown.push(new);
        }
        old += u64::from(on_left);
        new += u64::from(on_right);
    }
    shown
}

fn state_of(event: &str) -> &'static str {
    match event {
        "APPROVE" => "APPROVED",
        "REQUEST_CHANGES" => "CHANGES_REQUESTED",
        "COMMENT" => "COMMENTED",
        _ => "PENDING",
    }
}

impl FakeGitHub {
    /// A review by `author` already on the pull request: a draft of the
    /// user's own, or one a delivery sent before it crashed. Answers its id.
    pub fn add_review(&self, repo: &str, number: u64, author: &str, body: &str, state: &str) -> u64 {
        let mut fake = locked(&self.0);
        let id = fake.next_id();
        let json = fake.review_json(repo, number, id, author, body, state, "");
        fake.reviews.push(Review { repo: repo.to_owned(), number, json, comments: Vec::new() });
        id
    }

    /// The pull request's reviews, oldest first, each with its line
    /// comments under `comments`.
    pub fn reviews(&self, repo: &str, number: u64) -> Vec<Value> {
        let fake = locked(&self.0);
        let on = fake.reviews.iter().filter(|review| review.repo == repo && review.number == number);
        on.map(|review| {
            let mut json = review.json.clone();
            json["comments"] = json!(review.comments);
            json
        })
        .collect()
    }
}

impl State {
    fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    #[allow(clippy::too_many_arguments)]
    fn review_json(&self, repo: &str, number: u64, id: u64, author: &str, body: &str, state: &str, sha: &str) -> Value {
        let mut json = json!({
            "id": id,
            "node_id": "PRR_kwDOAJy2Ks4",
            "user": user(author),
            "body": body,
            "state": state,
            "html_url": format!("https://github.com/{repo}/pull/{number}#pullrequestreview-{id}"),
            "pull_request_url": format!("https://api.github.com/repos/{repo}/pulls/{number}"),
            "author_association": "OWNER",
            "_links": { "html": { "href": format!("https://github.com/{repo}/pull/{number}#pullrequestreview-{id}") } },
            "commit_id": sha,
        });
        if state != "PENDING" {
            json["submitted_at"] = "2026-11-18T10:00:00Z".into();
        }
        json
    }

    fn review_at(&mut self, repo: &str, number: u64, id: &str) -> Option<usize> {
        let id: u64 = id.parse().ok()?;
        self.reviews.iter().position(|review| review.repo == repo && review.number == number && review.json["id"] == id)
    }

    pub(super) fn review_route(&mut self, method: Method, repo: &str, rest: &[&str], body: &Value) -> HttpResponse {
        if let (Method::Delete, ["comments", id]) = (method, rest) {
            let id: u64 = id.parse().unwrap_or_default();
            for review in self.reviews.iter_mut().filter(|review| review.repo == repo) {
                review.comments.retain(|comment| comment["id"] != id);
            }
            return HttpResponse { status: 204, ..HttpResponse::default() };
        }
        let Some(number) = rest.first().and_then(|n| n.parse::<u64>().ok()) else { return not_found() };
        let author = match self.pulls.get(&(repo.to_owned(), number)) {
            Some(pull) => pull.json["user"]["login"].as_str().unwrap_or_default().to_owned(),
            None => return not_found(),
        };
        let at = |state: &mut State, id: &str| state.review_at(repo, number, id);
        match (method, &rest[1..]) {
            (Method::Get, ["reviews"]) => {
                let login = self.login.clone();
                let visible = self.reviews.iter().filter(|review| {
                    review.repo == repo
                        && review.number == number
                        && (review.json["state"] != "PENDING" || review.json["user"]["login"] == login.as_str())
                });
                answer(200, &json!(visible.map(|review| review.json.clone()).collect::<Vec<_>>()))
            }
            (Method::Post, ["reviews"]) => self.create(repo, number, &author, body),
            (Method::Post, ["reviews", id, "events"]) => match at(self, id) {
                Some(i) if self.reviews[i].json["state"] == "PENDING" => {
                    let event = body["event"].as_str().unwrap_or_default();
                    if matches!(event, "APPROVE" | "REQUEST_CHANGES") && author == self.login {
                        return unprocessable(
                            "Could not approve for pull request review. Can not approve your own pull request",
                        );
                    }
                    self.reviews[i].json["state"] = state_of(event).into();
                    self.reviews[i].json["submitted_at"] = "2026-11-18T10:00:00Z".into();
                    answer(200, &self.reviews[i].json)
                }
                Some(_) => unprocessable("Can not submit a review that is not pending"),
                None => not_found(),
            },
            (Method::Get, ["reviews", id]) => {
                at(self, id).map_or_else(not_found, |i| answer(200, &self.reviews[i].json))
            }
            (Method::Delete, ["reviews", id]) => match at(self, id) {
                Some(i) if self.reviews[i].json["state"] == "PENDING" => answer(200, &self.reviews.remove(i).json),
                Some(_) => unprocessable("Can not delete a non-pending pull request review"),
                None => not_found(),
            },
            (Method::Put, ["reviews", id]) => match at(self, id) {
                Some(i) => {
                    self.reviews[i].json["body"] = body["body"].clone();
                    answer(200, &self.reviews[i].json)
                }
                None => not_found(),
            },
            (Method::Get, ["reviews", id, "comments"]) => {
                at(self, id).map_or_else(not_found, |i| answer(200, &json!(self.reviews[i].comments)))
            }
            (Method::Put, ["reviews", id, "dismissals"]) => match at(self, id) {
                _ if self.dismissals_refused => {
                    answer(403, &json!({ "message": "Must have admin rights to Repository.", "status": "403" }))
                }
                Some(i) => {
                    self.reviews[i].json["state"] = "DISMISSED".into();
                    answer(200, &self.reviews[i].json)
                }
                None => not_found(),
            },
            _ => not_found(),
        }
    }

    /// `POST …/reviews`: refused whole, as GitHub does, for a second pending
    /// review, the author's approval, or a comment outside the diff.
    fn create(&mut self, repo: &str, number: u64, author: &str, body: &Value) -> HttpResponse {
        let login = self.login.clone();
        let pending = self.reviews.iter().any(|review| {
            review.repo == repo
                && review.number == number
                && review.json["state"] == "PENDING"
                && review.json["user"]["login"] == login.as_str()
        });
        if pending {
            return unprocessable("User can only have one pending review per pull request");
        }
        let event = body["event"].as_str().unwrap_or_default();
        if author == login && event == "APPROVE" {
            return unprocessable("Review Can not approve your own pull request");
        }
        if author == login && event == "REQUEST_CHANGES" {
            return unprocessable("Review Can not request changes on your own pull request");
        }
        let files = self.pulls.get(&(repo.to_owned(), number)).map(|pull| pull.files.clone()).unwrap_or_default();
        let mut comments = Vec::new();
        for comment in body["comments"].as_array().into_iter().flatten() {
            let path = comment["path"].as_str().unwrap_or_default();
            let Some(file) = files.iter().find(|file| file["filename"] == path) else {
                return unprocessable("Path could not be resolved");
            };
            let side = comment["side"].as_str().unwrap_or("RIGHT");
            let shown = lines(file["patch"].as_str().unwrap_or_default(), side);
            let lines_of = [comment["line"].as_u64(), comment["start_line"].as_u64()];
            if lines_of.iter().flatten().any(|line| !shown.contains(line)) {
                return unprocessable("Line could not be resolved");
            }
            let id = self.next_id();
            let mut kept = comment.clone();
            kept["id"] = id.into();
            comments.push(kept);
        }
        let id = self.next_id();
        let sha = body["commit_id"].as_str().unwrap_or_default();
        let text = body["body"].as_str().unwrap_or_default();
        let json = self.review_json(repo, number, id, &login, text, state_of(event), sha);
        self.reviews.push(Review { repo: repo.to_owned(), number, json: json.clone(), comments });
        answer(200, &json)
    }
}
