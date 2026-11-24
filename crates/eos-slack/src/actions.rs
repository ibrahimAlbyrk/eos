//! The read actions: who signed in and with which scopes, the user's
//! conversations, people, a conversation's or a thread's messages, and a
//! search. People's names are kept in memory for an hour, never stored.
//! Everything a person wrote or named comes back as outside text.

use std::sync::Mutex;

use eos_contracts::CapabilityItem;
use eos_core::capability::{ActionContext, ActionError};
use serde_json::{Value, json};

use crate::Slack;
use crate::manifest::MESSAGE;

/// How long people's names are kept.
const PEOPLE_MS: i64 = 60 * 60 * 1000;

pub(crate) fn text<'a>(value: &'a Value, name: &str) -> &'a str {
    value[name].as_str().unwrap_or_default()
}

fn limit(input: &Value, default: u64) -> String {
    input["limit"].as_u64().unwrap_or(default).to_string()
}

/// The workspace's people as `users.list` gave them, and when.
#[derive(Debug, Default)]
pub(crate) struct People(Mutex<Option<(i64, Vec<Value>)>>);

/// A message as the read actions answer it.
pub(crate) fn message(raw: &Value) -> Value {
    let mut out = json!({ "ts": text(raw, "ts"), "user": text(raw, "user"), "text": text(raw, "text") });
    if let Some(name) = raw["user_profile"]["real_name"].as_str().or_else(|| raw["username"].as_str()) {
        out["userName"] = json!(name);
    }
    if let Some(thread) = raw["thread_ts"].as_str() {
        out["threadTs"] = json!(thread);
    }
    if let Some(replies) = raw["reply_count"].as_i64() {
        out["replies"] = json!(replies);
    }
    out
}

/// A message's time in ms, from its `ts` (`1712345678.000100`).
pub(crate) fn ms_of(ts: &str) -> i64 {
    ts.split('.').next().and_then(|secs| secs.parse::<i64>().ok()).unwrap_or_default() * 1000
}

/// Text cut to `max` characters, for a title.
pub(crate) fn clip(text: &str, max: usize) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    if line.chars().count() <= max {
        line.to_owned()
    } else {
        format!("{}…", line.chars().take(max).collect::<String>())
    }
}

/// A search match as an item for the user to pick.
pub(crate) fn candidate(team: &str, raw: &Value) -> CapabilityItem {
    let conversation = text(&raw["channel"], "id");
    let ts = text(raw, "ts");
    CapabilityItem {
        key: format!("slack:{team}:{conversation}:{ts}"),
        kind: MESSAGE.to_owned(),
        title: clip(text(raw, "text"), 80),
        url: raw["permalink"].as_str().map(str::to_owned),
        updated_at: ms_of(ts),
        data: json!({ "conversation": conversation, "ts": ts }),
    }
}

impl Slack {
    pub(crate) async fn check(&self, ctx: &ActionContext) -> Result<Value, ActionError> {
        self.as_user(ctx, "auth.test", None, &[]).await?;
        Ok(json!({ "ok": true }))
    }

    /// The scopes Slack reports for the token, from `auth.test`.
    pub(crate) async fn scopes(&self, ctx: &ActionContext) -> Result<Vec<String>, ActionError> {
        let pair = self.pair(ctx).await?;
        let (_, headers) = self.exchange(Some(&pair.access), "auth.test", None, &[]).await?;
        let scopes = headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("x-oauth-scopes"));
        Ok(scopes.map(|(_, list)| list.split(',').map(|scope| scope.trim().to_owned()).collect()).unwrap_or_default())
    }

    async fn people(&self, ctx: &ActionContext) -> Result<Vec<Value>, ActionError> {
        let now = self.clock.now_ms();
        if let Some((at, people)) = self.people.0.lock().unwrap_or_else(|p| p.into_inner()).as_ref()
            && now - at < PEOPLE_MS
        {
            return Ok(people.clone());
        }
        let answer = self.as_user(ctx, "users.list", None, &[("limit", "200")]).await?;
        let people: Vec<Value> = answer["members"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|member| member["deleted"] != Value::Bool(true))
            .map(|member| json!({ "id": text(member, "id"), "name": text(member, "name"), "realName": text(&member["profile"], "real_name") }))
            .collect();
        *self.people.0.lock().unwrap_or_else(|p| p.into_inner()) = Some((now, people.clone()));
        Ok(people)
    }

    pub(crate) async fn list_conversations(&self, input: &Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let fields =
            [("types", "public_channel,private_channel,im,mpim"), ("exclude_archived", "true"), ("limit", "200")];
        let answer = self.as_user(ctx, "users.conversations", None, &fields).await?;
        let rows = answer["channels"].as_array().cloned().unwrap_or_default();
        let people =
            if rows.iter().any(|row| row["is_im"] == Value::Bool(true)) { self.people(ctx).await? } else { Vec::new() };
        let name_of = |id: &str| {
            people.iter().find(|person| text(person, "id") == id).map(|person| {
                let real = text(person, "realName");
                if real.is_empty() { text(person, "name").to_owned() } else { real.to_owned() }
            })
        };
        let q = text(input, "q").to_lowercase();
        let max = input["limit"].as_u64().unwrap_or(200) as usize;
        let conversations: Vec<Value> = rows
            .iter()
            .map(|row| {
                let (kind, name) = if row["is_im"] == Value::Bool(true) {
                    ("dm", name_of(text(row, "user")).unwrap_or_default())
                } else if row["is_mpim"] == Value::Bool(true) {
                    ("group", text(row, "name").to_owned())
                } else if row["is_private"] == Value::Bool(true) {
                    ("private", text(row, "name").to_owned())
                } else {
                    ("channel", text(row, "name").to_owned())
                };
                json!({ "id": text(row, "id"), "kind": kind, "name": name, "topic": text(&row["topic"], "value"), "member": true })
            })
            .filter(|row| q.is_empty() || text(row, "name").to_lowercase().contains(&q))
            .take(max)
            .collect();
        tracing::info!(capability = crate::ID, conversations = conversations.len(), "listed Slack conversations");
        Ok(json!({ "conversations": conversations }))
    }

    pub(crate) async fn find_people(&self, input: &Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let q = text(input, "q").trim().to_lowercase();
        let max = input["limit"].as_u64().unwrap_or(50) as usize;
        if q.contains('@') {
            let answer = self.as_user(ctx, "users.lookupByEmail", None, &[("email", &q)]).await;
            let people = match answer {
                Ok(answer) => vec![json!({
                    "id": text(&answer["user"], "id"), "name": text(&answer["user"], "name"),
                    "realName": text(&answer["user"]["profile"], "real_name"),
                })],
                Err(ActionError::Failed { kind: eos_core::capability::FailureKind::Gone }) => Vec::new(),
                Err(error) => return Err(error),
            };
            return Ok(json!({ "people": people }));
        }
        let people: Vec<Value> = self
            .people(ctx)
            .await?
            .into_iter()
            .filter(|person| {
                text(person, "name").to_lowercase().contains(&q) || text(person, "realName").to_lowercase().contains(&q)
            })
            .take(max)
            .collect();
        Ok(json!({ "people": people }))
    }

    pub(crate) async fn read_messages(
        &self,
        input: &Value,
        ctx: &ActionContext,
        thread: bool,
    ) -> Result<Value, ActionError> {
        let conversation = text(input, "conversation");
        let count = limit(input, 50);
        let mut fields = vec![("channel", conversation), ("limit", count.as_str())];
        let (method, thread_ts) =
            if thread { ("conversations.replies", text(input, "threadTs")) } else { ("conversations.history", "") };
        if thread {
            fields.push(("ts", thread_ts));
        }
        for (name, field) in [("since", "oldest"), ("cursor", "cursor")] {
            if let Some(value) = input[name].as_str().filter(|value| !value.is_empty()) {
                fields.push((field, value));
            }
        }
        let answer = self.as_user(ctx, method, Some(conversation), &fields).await?;
        let messages: Vec<Value> = answer["messages"].as_array().into_iter().flatten().map(message).collect();
        let mut out = json!({ "messages": messages });
        if let Some(next) = answer["response_metadata"]["next_cursor"].as_str().filter(|next| !next.is_empty()) {
            out["cursor"] = json!(next);
        }
        Ok(out)
    }

    async fn search(&self, ctx: &ActionContext, query: &str, count: &str) -> Result<Vec<Value>, ActionError> {
        let fields = [("query", query), ("count", count), ("sort", "timestamp"), ("sort_dir", "desc")];
        let answer = self.as_user(ctx, "search.messages", None, &fields).await?;
        Ok(answer["messages"]["matches"].as_array().cloned().unwrap_or_default())
    }

    pub(crate) async fn search_messages(&self, input: &Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let matches = self.search(ctx, text(input, "q"), &limit(input, 20)).await?;
        let matches: Vec<Value> = matches
            .iter()
            .map(|raw| {
                json!({
                    "conversation": text(&raw["channel"], "id"), "ts": text(raw, "ts"), "user": text(raw, "user"),
                    "userName": text(raw, "username"), "text": text(raw, "text"), "permalink": text(raw, "permalink"),
                })
            })
            .collect();
        Ok(json!({ "matches": matches }))
    }

    /// Messages to pick: a search, or the newest ones that mention the user.
    pub(crate) async fn find_messages(&self, input: &Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let pair = self.pair(ctx).await?;
        let query = match text(input, "q").trim() {
            "" => format!("<@{}>", pair.user_id),
            q => q.to_owned(),
        };
        let matches = self.search(ctx, &query, &limit(input, 20)).await?;
        let items: Vec<CapabilityItem> = matches.iter().map(|raw| candidate(&pair.team_id, raw)).collect();
        Ok(json!({ "items": items }))
    }
}
