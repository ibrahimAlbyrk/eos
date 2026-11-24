//! Slack in memory, behind `eos_slack::Transport`: one workspace and one
//! signed-in user, the PKCE exchange (no secret taken, the verifier held to
//! its challenge), rotating tokens whose refresh token works once,
//! conversations with their messages and metadata, people, search, posts,
//! deletes and rate limits. Bodies follow Slack's documented shapes; calls
//! are recorded without their token.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use eos_core::BoxFuture;
use eos_slack::{HttpRequest, HttpResponse, Transport};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The workspace and the user who signs in.
pub const SLACK_TEAM: &str = "T0ACME001";
pub const SLACK_USER: &str = "U0ME00001";
/// The code Slack's callback carries.
pub const SLACK_CODE: &str = "slack-fake-code-1";

fn locked<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// One call the fake took: the method, its form fields (the token and a
/// refresh token left out) and whether it carried an access token Slack takes.
#[derive(Debug, Clone, PartialEq)]
pub struct SlackCall {
    pub method: String,
    pub fields: BTreeMap<String, String>,
    pub signed_in: bool,
}

#[derive(Debug, Default)]
struct State {
    access: String,
    refresh: String,
    used_refresh: HashSet<String>,
    serial: u64,
    challenge: Option<String>,
    scopes: String,
    conversations: BTreeMap<String, Value>,
    messages: BTreeMap<String, Vec<Value>>,
    people: Vec<Value>,
    next_ts: u64,
    limited: HashMap<String, u64>,
    refused: HashMap<String, String>,
    calls: Vec<SlackCall>,
}

#[derive(Debug)]
pub struct FakeSlack(Mutex<State>);

impl Default for FakeSlack {
    fn default() -> Self {
        Self::new()
    }
}

fn ok(body: Value) -> HttpResponse {
    let mut body = body;
    body["ok"] = json!(true);
    HttpResponse { status: 200, headers: Vec::new(), body: body.to_string().into_bytes() }
}

fn refused(code: &str) -> HttpResponse {
    HttpResponse {
        status: 200,
        headers: Vec::new(),
        body: json!({"ok": false, "error": code}).to_string().into_bytes(),
    }
}

impl FakeSlack {
    /// Signed out; every scope Eos asks for granted at sign-in.
    pub fn new() -> Self {
        let state = State { scopes: eos_slack::USER_SCOPES.join(","), next_ts: 1_795_000_000, ..State::default() };
        Self(Mutex::new(state))
    }

    /// Signed in already: the token pair `token_secret` names.
    pub fn signed_in(self) -> Self {
        {
            let mut state = locked(&self.0);
            state.access = "xoxe.xoxp-fake-0".into();
            state.refresh = "xoxe-1-fake-0".into();
        }
        self
    }

    /// The `token` secret of a signed-in fake, ending at `expires_at`.
    pub fn token_secret(&self, expires_at: i64) -> String {
        let state = locked(&self.0);
        json!({"access": state.access, "refresh": state.refresh, "expiresAt": expires_at,
               "teamId": SLACK_TEAM, "userId": SLACK_USER})
        .to_string()
    }

    /// The challenge the sign-in's verifier must hash to.
    pub fn expect_challenge(&self, challenge: &str) {
        locked(&self.0).challenge = Some(challenge.to_owned());
    }

    pub fn scopes(&self, scopes: &str) {
        locked(&self.0).scopes = scopes.to_owned();
    }

    /// Takes the token away, as Slack does when access is turned off.
    pub fn revoke(&self) {
        let mut state = locked(&self.0);
        state.access.clear();
        state.refresh.clear();
    }

    /// A conversation (`C…` channel, `G…` private, `D…` direct message).
    pub fn conversation(&self, id: &str, name: &str) {
        let kind = |prefix: char| id.starts_with(prefix);
        let row = json!({"id": id, "name": name, "is_channel": kind('C'), "is_private": kind('G'),
                         "is_im": kind('D'), "is_mpim": false, "topic": {"value": format!("About {name}")}});
        locked(&self.0).conversations.insert(id.to_owned(), row);
    }

    pub fn person(&self, id: &str, name: &str, real_name: &str, email: &str) {
        locked(&self.0)
            .people
            .push(json!({"id": id, "name": name, "profile": {"real_name": real_name, "email": email}}));
    }

    /// A message by `user` in `conversation`; its `ts`.
    pub fn message(&self, conversation: &str, user: &str, text: &str) -> String {
        self.add(conversation, json!({"user": user, "text": text}))
    }

    /// A message with any fields Slack gives one; its `ts`.
    pub fn add(&self, conversation: &str, mut message: Value) -> String {
        let mut state = locked(&self.0);
        state.next_ts += 1;
        let ts = format!("{}.000100", state.next_ts);
        message["ts"] = json!(ts);
        message["type"] = json!("message");
        state.messages.entry(conversation.to_owned()).or_default().push(message);
        ts
    }

    pub fn messages(&self, conversation: &str) -> Vec<Value> {
        locked(&self.0).messages.get(conversation).cloned().unwrap_or_default()
    }

    /// `method` answers 429 with `Retry-After: retry_after_s` from now on.
    pub fn limit(&self, method: &str, retry_after_s: u64) {
        locked(&self.0).limited.insert(method.to_owned(), retry_after_s);
    }

    pub fn unlimit(&self, method: &str) {
        locked(&self.0).limited.remove(method);
    }

    /// `method` answers `{"ok": false, "error": code}`.
    pub fn refuse(&self, method: &str, code: &str) {
        locked(&self.0).refused.insert(method.to_owned(), code.to_owned());
    }

    pub fn calls(&self) -> Vec<SlackCall> {
        locked(&self.0).calls.clone()
    }

    /// The calls of `method`.
    pub fn calls_of(&self, method: &str) -> Vec<SlackCall> {
        self.calls().into_iter().filter(|call| call.method == method).collect()
    }

    fn answer(&self, request: &HttpRequest) -> HttpResponse {
        let method = request.method().to_owned();
        let fields: HashMap<String, String> = request.fields().into_iter().collect();
        let mut state = locked(&self.0);
        let bearer =
            request.header("authorization").and_then(|value| value.strip_prefix("Bearer ")).unwrap_or_default();
        let signed_in = !state.access.is_empty() && bearer == state.access;
        let recorded = fields
            .iter()
            .filter(|(name, _)| !matches!(name.as_str(), "refresh_token" | "code" | "code_verifier"))
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        state.calls.push(SlackCall { method: method.clone(), fields: recorded, signed_in });
        if let Some(retry) = state.limited.get(&method) {
            let headers = vec![("Retry-After".to_owned(), retry.to_string())];
            return HttpResponse { status: 429, headers, body: b"{\"ok\":false,\"error\":\"ratelimited\"}".to_vec() };
        }
        if let Some(code) = state.refused.get(&method) {
            return refused(code);
        }
        if method == "oauth.v2.access" {
            return exchange(&mut state, &fields);
        }
        if !signed_in {
            return refused(if bearer.is_empty() { "not_authed" } else { "invalid_auth" });
        }
        let field = |name: &str| fields.get(name).cloned().unwrap_or_default();
        match method.as_str() {
            "auth.test" => {
                let mut answer = ok(
                    json!({"url": "https://acme.slack.com/", "team": "Acme", "user": "me", "team_id": SLACK_TEAM, "user_id": SLACK_USER}),
                );
                answer.headers.push(("x-oauth-scopes".into(), state.scopes.clone()));
                answer
            }
            "users.conversations" => ok(json!({"channels": state.conversations.values().cloned().collect::<Vec<_>>()})),
            "users.list" => ok(json!({"members": state.people})),
            "users.lookupByEmail" => {
                let email = field("email");
                match state.people.iter().find(|person| person["profile"]["email"] == email.as_str()) {
                    Some(person) => ok(json!({"user": person})),
                    None => refused("users_not_found"),
                }
            }
            "conversations.open" => ok(json!({"channel": {"id": format!("D{}", field("users"))}})),
            "conversations.history" | "conversations.replies" => {
                let Some(all) = state
                    .messages
                    .get(&field("channel"))
                    .cloned()
                    .or_else(|| state.conversations.contains_key(&field("channel")).then(Vec::new))
                else {
                    return refused("channel_not_found");
                };
                let oldest: f64 = field("oldest").parse().unwrap_or(0.0);
                let inclusive = field("inclusive") == "true";
                let thread = field("ts");
                let limit: usize = field("limit").parse().unwrap_or(100);
                let mut picked: Vec<Value> = all
                    .into_iter()
                    .filter(|m| {
                        let ts: f64 = m["ts"].as_str().unwrap_or_default().parse().unwrap_or(0.0);
                        ts > oldest || (inclusive && ts == oldest)
                    })
                    .filter(|m| {
                        if method == "conversations.replies" {
                            m["ts"] == thread.as_str() || m["thread_ts"] == thread.as_str()
                        } else {
                            m.get("thread_ts").is_none()
                                || m["thread_ts"] == m["ts"]
                                || m["subtype"] == "thread_broadcast"
                        }
                    })
                    .collect();
                picked.reverse();
                picked.truncate(limit);
                if field("include_all_metadata") != "true" {
                    for message in &mut picked {
                        message.as_object_mut().map(|m| m.remove("metadata"));
                    }
                }
                ok(json!({"messages": picked, "has_more": false}))
            }
            "chat.postMessage" => {
                let channel = field("channel");
                if channel.starts_with('C') && !state.conversations.contains_key(&channel) {
                    return refused("channel_not_found");
                }
                let mut message = json!({"user": SLACK_USER, "text": field("text")});
                let thread = field("thread_ts");
                if !thread.is_empty() {
                    let parent =
                        state.messages.get(&channel).is_some_and(|all| all.iter().any(|m| m["ts"] == thread.as_str()));
                    if !parent {
                        return refused("thread_not_found");
                    }
                    message["thread_ts"] = json!(thread);
                }
                if let Ok(metadata) = serde_json::from_str::<Value>(&field("metadata")) {
                    message["metadata"] = metadata;
                }
                state.next_ts += 1;
                let ts = format!("{}.000100", state.next_ts);
                message["ts"] = json!(ts);
                state.messages.entry(channel.clone()).or_default().push(message);
                ok(json!({"channel": channel, "ts": ts}))
            }
            "chat.getPermalink" => ok(json!({"permalink": format!(
                "https://acme.slack.com/archives/{}/p{}", field("channel"), field("message_ts").replace('.', "")
            )})),
            "chat.delete" => {
                let (channel, ts) = (field("channel"), field("ts"));
                let Some(all) = state.messages.get_mut(&channel) else { return refused("channel_not_found") };
                let before = all.len();
                all.retain(|m| m["ts"] != ts.as_str());
                if all.len() == before {
                    refused("message_not_found")
                } else {
                    ok(json!({"channel": channel, "ts": ts}))
                }
            }
            "search.messages" => {
                let query = field("query");
                let mut matches: Vec<Value> = state
                    .messages
                    .iter()
                    .flat_map(|(channel, all)| {
                        all.iter().filter(|m| m["text"].as_str().is_some_and(|text| text.contains(&query))).map(
                            move |m| {
                                let mut hit = m.clone();
                                hit["channel"] = json!({"id": channel});
                                hit["permalink"] = json!(format!("https://acme.slack.com/archives/{channel}/p1"));
                                hit.as_object_mut().map(|h| h.remove("metadata"));
                                hit
                            },
                        )
                    })
                    .collect();
                matches.sort_by(|a, b| b["ts"].as_str().cmp(&a["ts"].as_str()));
                ok(json!({"messages": {"matches": matches}}))
            }
            _ => refused("unknown_method"),
        }
    }
}

/// `oauth.v2.access`: a code exchanged with its verifier, or a refresh
/// token used once. Never a client secret.
fn exchange(state: &mut State, fields: &HashMap<String, String>) -> HttpResponse {
    if fields.contains_key("client_secret") {
        return refused("invalid_arguments");
    }
    let field = |name: &str| fields.get(name).cloned().unwrap_or_default();
    let refreshing = field("grant_type") == "refresh_token";
    if refreshing {
        let given = field("refresh_token");
        if given.is_empty() || given != state.refresh || state.used_refresh.contains(&given) {
            return refused("invalid_refresh_token");
        }
        state.used_refresh.insert(given);
    } else {
        let verifier = field("code_verifier");
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        if field("code") != SLACK_CODE || state.challenge.as_deref() != Some(challenge.as_str()) {
            return refused("invalid_code");
        }
    }
    state.serial += 1;
    state.access = format!("xoxe.xoxp-fake-{}", state.serial);
    state.refresh = format!("xoxe-1-fake-{}", state.serial);
    let pair = json!({"id": SLACK_USER, "access_token": state.access, "refresh_token": state.refresh,
                      "expires_in": 43_200, "token_type": "user"});
    let team = json!({"id": SLACK_TEAM, "name": "Acme"});
    if refreshing {
        let mut answer = pair;
        answer["team"] = team;
        answer["user_id"] = json!(SLACK_USER);
        ok(answer)
    } else {
        ok(json!({"authed_user": pair, "team": team}))
    }
}

impl Transport for FakeSlack {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, eos_slack::Error>> {
        let answer = self.answer(&request);
        Box::pin(std::future::ready(Ok(answer)))
    }
}
