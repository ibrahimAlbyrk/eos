//! The two sources (06 §4.7, D62), polled once a minute. `messages` reads a
//! conversation's history from the cursor's last `ts` on, inclusive, and
//! skips the keys it saw at that `ts`; `mentions` searches the user's own
//! mention, newest first, and keeps the keys seen in the last hour, since
//! search lags. The first poll only marks what is there. A post of Eos (its
//! metadata) never becomes a signal, and neither does the user's own
//! mention of themselves, so a routine cannot start itself. While Slack
//! holds history for a minute or more, the conversations take turns: one
//! history call each, in order, and `pollAfterS` says when each one's turn
//! comes.

use std::collections::VecDeque;
use std::sync::Mutex;

use eos_core::capability::{ActionContext, ActionError};
use serde_json::{Value, json};

use crate::Slack;
use crate::actions::{clip, ms_of, text};
use crate::sends::DELIVERY_EVENT;

/// How often a source polls.
const POLL_S: u64 = 60;
/// How long a mention's key is kept.
const MENTION_KEEP_MS: i64 = 60 * 60 * 1000;
/// A history wait this long or longer makes the conversations take turns.
const TURN_AFTER_S: u64 = 60;

/// The conversations waiting for a history call while Slack holds history.
#[derive(Debug, Default)]
pub(crate) struct Turns(Mutex<VecDeque<String>>);

impl Turns {
    /// Where `conversation` stands in the line, if it waits in it.
    fn waits(&self, conversation: &str) -> Option<usize> {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).iter().position(|waiting| waiting == conversation)
    }

    /// Where `conversation` stands in the line, joining it if it was not.
    fn place(&self, conversation: &str) -> usize {
        let mut line = self.0.lock().unwrap_or_else(|p| p.into_inner());
        match line.iter().position(|waiting| waiting == conversation) {
            Some(at) => at,
            None => {
                line.push_back(conversation.to_owned());
                line.len() - 1
            }
        }
    }

    fn served(&self, conversation: &str) {
        self.0.lock().unwrap_or_else(|p| p.into_inner()).retain(|waiting| waiting != conversation);
    }
}

/// The facts and item of one message.
fn item(team: &str, me: &str, conversation: &str, raw: &Value, event: &str) -> Value {
    let ts = text(raw, "ts");
    let thread = raw["thread_ts"].as_str().filter(|thread| *thread != ts);
    let body = text(raw, "text");
    let mut data = json!({ "text": body });
    if let Some(name) = raw["user_profile"]["real_name"].as_str().or_else(|| raw["username"].as_str()) {
        data["userName"] = json!(name);
    }
    if let Some(thread) = raw["thread_ts"].as_str() {
        data["threadTs"] = json!(thread);
    }
    let mut out = json!({
        "key": format!("slack:{team}:{conversation}:{ts}"),
        "event": event,
        "title": clip(body, 80),
        "text": body,
        "updatedAt": ms_of(ts),
        "facts": {
            "conversation": conversation, "from": text(raw, "user"), "fromMe": text(raw, "user") == me,
            "mentionsMe": body.contains(&format!("<@{me}>")), "isDm": conversation.starts_with('D'),
            "inThread": thread.is_some(),
        },
        "data": data,
    });
    if let Some(permalink) = raw["permalink"].as_str() {
        out["url"] = json!(permalink);
    }
    out
}

/// Whether a message is one a person wrote that a routine may start on.
fn signals(raw: &Value) -> bool {
    let subtype = text(raw, "subtype");
    raw["metadata"]["event_type"] != DELIVERY_EVENT && (subtype.is_empty() || subtype == "thread_broadcast")
}

fn polled(items: Vec<Value>, cursor: Value, after_s: u64, baseline: bool) -> Value {
    json!({ "items": items, "cursor": cursor, "pollAfterS": after_s, "baseline": baseline })
}

impl Slack {
    pub(crate) async fn poll_messages(&self, input: &Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let conversation = text(input, "conversation");
        let cursor = &input["cursor"];
        let since = text(cursor, "ts");
        let held = self.rate.held("conversations.history", self.clock.now_ms()).filter(|s| *s >= TURN_AFTER_S);
        let place = match held {
            Some(_) => Some(self.turns.place(conversation)),
            None => self.turns.waits(conversation),
        };
        match (held, place) {
            (Some(wait_s), Some(place)) => {
                return Ok(polled(Vec::new(), cursor.clone(), wait_s + TURN_AFTER_S * place as u64, false));
            }
            (None, Some(place)) if place > 0 => {
                return Ok(polled(Vec::new(), cursor.clone(), TURN_AFTER_S * place as u64, false));
            }
            _ => {}
        }
        let pair = self.pair(ctx).await?;
        let mut fields = vec![("channel", conversation), ("include_all_metadata", "true")];
        if since.is_empty() {
            fields.push(("limit", "15"));
        } else {
            fields.extend([("oldest", since), ("inclusive", "true"), ("limit", "100")]);
        }
        let answer = match self.as_user(ctx, "conversations.history", Some(conversation), &fields).await {
            Ok(answer) => answer,
            Err(ActionError::RateLimited { retry_after_s }) if retry_after_s >= TURN_AFTER_S => {
                let place = self.turns.place(conversation) as u64;
                return Ok(polled(Vec::new(), cursor.clone(), retry_after_s + TURN_AFTER_S * place, false));
            }
            Err(error) => return Err(error),
        };
        self.turns.served(conversation);
        let mut messages: Vec<&Value> = answer["messages"].as_array().into_iter().flatten().collect();
        messages.sort_by(|a, b| ms_ts(text(a, "ts")).total_cmp(&ms_ts(text(b, "ts"))));
        // An empty conversation's baseline still ends: later polls read from its start.
        let newest =
            messages.last().map_or(if since.is_empty() { "0" } else { since }, |raw| text(raw, "ts")).to_owned();
        let seen: Vec<&str> = cursor["seen"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let next_seen: Vec<&str> =
            messages.iter().filter(|raw| text(raw, "ts") == newest).map(|raw| text(raw, "ts")).collect();
        let next = json!({ "ts": newest, "seen": next_seen });
        if since.is_empty() {
            return Ok(polled(Vec::new(), next, POLL_S, true));
        }
        let items: Vec<Value> = messages
            .iter()
            .filter(|raw| !seen.contains(&text(raw, "ts")) && signals(raw))
            .map(|raw| item(&pair.team_id, &pair.user_id, conversation, raw, "posted"))
            .collect();
        tracing::info!(capability = crate::ID, conversation, items = items.len(), "polled a Slack conversation");
        Ok(polled(items, next, POLL_S, false))
    }

    pub(crate) async fn poll_mentions(&self, input: &Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let pair = self.pair(ctx).await?;
        let cursor = &input["cursor"];
        let baseline = cursor["ts"].as_str().is_none();
        let query = format!("<@{}>", pair.user_id);
        let fields = [("query", query.as_str()), ("count", "20"), ("sort", "timestamp"), ("sort_dir", "desc")];
        let answer = self.as_user(ctx, "search.messages", None, &fields).await?;
        let now = self.clock.now_ms();
        let seen: Vec<&str> = cursor["mentions"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let matches: Vec<&Value> = answer["messages"]["matches"].as_array().into_iter().flatten().collect();
        let key_of = |raw: &Value| format!("{}:{}", text(&raw["channel"], "id"), text(raw, "ts"));
        let mut kept: Vec<String> = matches
            .iter()
            .filter(|raw| now - ms_of(text(raw, "ts")) < MENTION_KEEP_MS)
            .map(|raw| key_of(raw))
            .collect();
        kept.sort();
        kept.dedup();
        let next = json!({ "ts": now.to_string(), "mentions": kept });
        if baseline {
            return Ok(polled(Vec::new(), next, POLL_S, true));
        }
        let mut items: Vec<Value> = Vec::new();
        for raw in matches {
            let key = key_of(raw);
            let fresh = !seen.contains(&key.as_str())
                && !items.iter().any(|item| item["key"].as_str().is_some_and(|k| k.ends_with(&key)));
            if fresh && text(raw, "user") != pair.user_id && signals(raw) {
                items.push(item(&pair.team_id, &pair.user_id, text(&raw["channel"], "id"), raw, "mentioned"));
            }
        }
        tracing::info!(capability = crate::ID, items = items.len(), "polled Slack mentions");
        Ok(polled(items, next, POLL_S, false))
    }
}

/// A `ts` as a number, for ordering.
fn ms_ts(ts: &str) -> f64 {
    ts.parse().unwrap_or_default()
}
