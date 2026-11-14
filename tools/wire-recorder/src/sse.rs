//! Server-sent events: text lines in, ordered stream items out.

use serde_json::{Value, json};

/// One thing an event stream carried.
#[derive(Debug, Clone, PartialEq)]
pub enum SseItem {
    /// `retry: <ms>`.
    Retry(u64),
    /// A `:comment` line (`:connected`, `:ka`).
    Comment(String),
    Event {
        id: Option<String>,
        event: Option<String>,
        data: String,
    },
}

impl SseItem {
    /// The recorded form. `data` is kept as JSON when it parses.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Retry(ms) => json!({ "retry": ms }),
            Self::Comment(text) => json!({ "comment": text }),
            Self::Event { id, event, data } => {
                let data = serde_json::from_str::<Value>(data).unwrap_or_else(|_| Value::String(data.clone()));
                json!({ "id": id, "event": event, "data": data })
            }
        }
    }

    /// The `reason` of a `change` event, which names the bus topic.
    pub fn reason(&self) -> Option<String> {
        let Self::Event { data, .. } = self else { return None };
        let data: Value = serde_json::from_str(data).ok()?;
        Some(data.get("reason")?.as_str()?.to_owned())
    }
}

/// Feeds on lines (without their line break) and yields complete items.
#[derive(Debug, Default)]
pub struct SseParser {
    id: Option<String>,
    event: Option<String>,
    data: Vec<String>,
    retry: Option<u64>,
}

impl SseParser {
    pub fn line(&mut self, line: &str) -> Option<SseItem> {
        if line.is_empty() {
            return self.dispatch();
        }
        if let Some(comment) = line.strip_prefix(':') {
            return Some(SseItem::Comment(comment.to_owned()));
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "id" => self.id = Some(value.to_owned()),
            "event" => self.event = Some(value.to_owned()),
            "data" => self.data.push(value.to_owned()),
            "retry" => self.retry = value.parse().ok(),
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseItem> {
        let (id, event, retry) = (self.id.take(), self.event.take(), self.retry.take());
        let data = std::mem::take(&mut self.data);
        if id.is_none() && event.is_none() && data.is_empty() {
            return retry.map(SseItem::Retry);
        }
        Some(SseItem::Event { id, event, data: data.join("\n") })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Vec<SseItem> {
        let mut parser = SseParser::default();
        text.split('\n').filter_map(|line| parser.line(line)).collect()
    }

    #[test]
    fn parses_the_daemon_preamble_and_events() {
        let items = parse(
            "retry: 2000\n\n:connected\n\nid: ab12-3\nevent: hello\ndata: {\"seq\":3}\n\n:ka\n\nid: ab12-4\nevent: change\ndata: {\"reason\":\"worker:change\",\"payload\":{}}\n\n",
        );
        assert_eq!(
            items,
            vec![
                SseItem::Retry(2000),
                SseItem::Comment("connected".into()),
                SseItem::Event { id: Some("ab12-3".into()), event: Some("hello".into()), data: "{\"seq\":3}".into() },
                SseItem::Comment("ka".into()),
                SseItem::Event {
                    id: Some("ab12-4".into()),
                    event: Some("change".into()),
                    data: "{\"reason\":\"worker:change\",\"payload\":{}}".into()
                },
            ]
        );
        assert_eq!(items[4].reason().as_deref(), Some("worker:change"));
        assert_eq!(items[2].reason(), None);
    }

    #[test]
    fn joins_data_lines_and_keeps_plain_text() {
        let items = parse("data: a\ndata: b\n\n");
        assert_eq!(items, vec![SseItem::Event { id: None, event: None, data: "a\nb".into() }]);
        assert_eq!(items[0].to_json(), json!({"id": null, "event": null, "data": "a\nb"}));
    }
}
