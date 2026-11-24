//! Posting as the user (06 §4.7): to a conversation, to a person (their
//! direct message is opened first), in a thread, or to the user's own
//! direct message. Every post turns off Slack's parsing, name linking and
//! link previews, so Slack never fetches a link of a result, and escapes
//! every broadcast, so a result never pings a crowd. Each post carries its
//! delivery's key in its metadata, which `find_delivery` looks for after an
//! answer was lost. A post is taken back by deleting it.

use eos_core::capability::{ActionContext, ActionError};
use serde_json::{Value, json};

use crate::Slack;
use crate::actions::text;
use crate::manifest::TEXT_MAX;

/// The metadata event a post of Eos carries.
pub(crate) const DELIVERY_EVENT: &str = "eos_delivery";

/// `text` with Slack's broadcasts (`<!here>`, `<!channel>`, `<!everyone>`,
/// `<!subteam^…>`) written as text.
pub(crate) fn escape_broadcasts(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("<!") {
        out.push_str(&rest[..at]);
        let name = rest[at + 2..].to_ascii_lowercase();
        let name = &name[..name.find(['>', '|', '^']).unwrap_or(name.len())];
        out.push_str(if matches!(name, "here" | "channel" | "everyone" | "subteam") { "&lt;!" } else { "<!" });
        rest = &rest[at + 2..];
    }
    out.push_str(rest);
    out
}

/// Whether `id` names a person (a user id) rather than a conversation.
fn person(id: &str) -> bool {
    id.starts_with(['U', 'W'])
}

impl Slack {
    /// The direct message with `user`, opened if it was not.
    async fn direct(&self, ctx: &ActionContext, user: &str) -> Result<String, ActionError> {
        let answer = self.as_user(ctx, "conversations.open", None, &[("users", user)]).await?;
        Ok(text(&answer["channel"], "id").to_owned())
    }

    async fn post(
        &self,
        ctx: &ActionContext,
        conversation: &str,
        thread_ts: Option<&str>,
        body: &str,
    ) -> Result<Value, ActionError> {
        if body.chars().count() > TEXT_MAX {
            return Err(ActionError::Invalid(format!(
                "Input validation error: text is longer than {TEXT_MAX} characters"
            )));
        }
        let escaped = escape_broadcasts(body);
        let metadata = ctx
            .idempotency_key
            .as_ref()
            .map(|key| json!({ "event_type": DELIVERY_EVENT, "event_payload": { "key": key } }).to_string());
        let mut fields = vec![
            ("channel", conversation),
            ("text", escaped.as_str()),
            ("parse", "none"),
            ("link_names", "false"),
            ("unfurl_links", "false"),
            ("unfurl_media", "false"),
        ];
        if let Some(thread_ts) = thread_ts {
            fields.push(("thread_ts", thread_ts));
        }
        if let Some(metadata) = &metadata {
            fields.push(("metadata", metadata));
        }
        let answer = self.as_user(ctx, "chat.postMessage", Some(conversation), &fields).await?;
        let (channel, ts) = (text(&answer, "channel"), text(&answer, "ts"));
        tracing::info!(capability = crate::ID, conversation = channel, ts, "posted to Slack");
        let mut receipt = json!({ "conversation": channel, "ts": ts });
        let link = self.as_user(ctx, "chat.getPermalink", None, &[("channel", channel), ("message_ts", ts)]).await;
        if let Some(permalink) = link.ok().as_ref().and_then(|answer| answer["permalink"].as_str()) {
            receipt["permalink"] = json!(permalink);
        }
        Ok(receipt)
    }

    pub(crate) async fn post_message(&self, input: &Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let to = text(input, "to");
        let conversation = if person(to) { self.direct(ctx, to).await? } else { to.to_owned() };
        self.post(ctx, &conversation, None, text(input, "text")).await
    }

    pub(crate) async fn reply_in_thread(&self, input: &Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        self.post(ctx, text(input, "conversation"), Some(text(input, "threadTs")), text(input, "text")).await
    }

    pub(crate) async fn tell_me(&self, input: &Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let me = self.pair(ctx).await?.user_id;
        let conversation = self.direct(ctx, &me).await?;
        self.post(ctx, &conversation, None, text(input, "text")).await
    }

    pub(crate) async fn delete_message(&self, input: &Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let conversation = text(input, "conversation");
        let fields = [("channel", conversation), ("ts", text(input, "ts"))];
        self.as_user(ctx, "chat.delete", Some(conversation), &fields).await?;
        tracing::info!(capability = crate::ID, conversation, "deleted a Slack post");
        Ok(json!({ "deleted": true }))
    }

    /// The post of the user's that carries `key` in its metadata, since `since` (ms).
    pub(crate) async fn find_delivery(&self, input: &Value, ctx: &ActionContext) -> Result<Value, ActionError> {
        let me = self.pair(ctx).await?.user_id;
        let conversation = text(input, "conversation");
        let since = format!("{}", input["since"].as_i64().unwrap_or_default() / 1000);
        let mut fields = vec![
            ("channel", conversation),
            ("oldest", since.as_str()),
            ("include_all_metadata", "true"),
            ("limit", "100"),
        ];
        let method = match input["threadTs"].as_str().filter(|ts| !ts.is_empty()) {
            Some(thread) => {
                fields.push(("ts", thread));
                "conversations.replies"
            }
            None => "conversations.history",
        };
        let answer = self.as_user(ctx, method, Some(conversation), &fields).await?;
        let key = text(input, "key");
        let found = answer["messages"].as_array().into_iter().flatten().find(|raw| {
            text(raw, "user") == me
                && raw["metadata"]["event_type"] == DELIVERY_EVENT
                && raw["metadata"]["event_payload"]["key"] == key
        });
        Ok(match found {
            Some(raw) => json!({ "found": true, "ts": text(raw, "ts") }),
            None => json!({ "found": false }),
        })
    }
}
