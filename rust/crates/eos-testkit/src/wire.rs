//! Replays a recorded scenario against a router, inside a test.
//!
//! `scripts/replay.sh` judges the composed app against every recording; this
//! is the same check for one feature's module in `cargo test`: each recorded
//! step is sent to the router and its answer — status, body, the events it
//! caused — must equal what today's daemon answered.
//!
//! Recordings are normalized (`<page:1>`, `<now>`, `{sandbox}`), so the
//! comparison binds each id token to the first value seen in its place and
//! requires the same value from then on.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine;
use eos_runtime::access::Caller;
use eos_runtime::bus::{Bus, Filter};
use eos_runtime::http::{Method, Request};
use eos_runtime::router::Router;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::FakeClock;
use crate::fixtures::recording;

/// One scenario replayed against one router.
pub struct Replay<'a> {
    pub router: &'a Router,
    pub bus: &'a Bus,
    /// Moved forward before every step, so "newest first" has an order.
    pub clock: &'a FakeClock,
    /// The scenario's variables (`sandbox`, `user_home`, …).
    pub vars: &'a [(&'a str, &'a str)],
    /// Steps of routes this router does not serve.
    pub skip: &'a [&'a str],
    /// When not empty: the only steps to run.
    pub only: &'a [&'a str],
}

impl std::fmt::Debug for Replay<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Replay")
            .field("vars", &self.vars)
            .field("skip", &self.skip)
            .field("only", &self.only)
            .finish_non_exhaustive()
    }
}

/// What a replay found.
#[derive(Debug, Default)]
pub struct Replayed {
    /// Steps sent to the router.
    pub steps: usize,
    /// One line per difference, `step: where: recorded … got …`.
    pub differences: Vec<String>,
}

impl Replayed {
    /// The differences without their values (`step: where`), for a replay
    /// over private data.
    pub fn places(&self) -> Vec<&str> {
        self.differences.iter().map(|d| d.split(": recorded ").next().unwrap_or(d)).collect()
    }
}

/// A scenario recorded on a private copy of real data, when
/// `EOS_PRIVATE_RECORDINGS` names the folder that holds it.
pub fn private_recording(scenario: &str) -> Option<Value> {
    let dir = std::env::var_os("EOS_PRIVATE_RECORDINGS")?;
    let text = std::fs::read(std::path::Path::new(&dir).join(format!("{scenario}.json"))).ok()?;
    serde_json::from_slice(&text).ok()
}

#[derive(Default)]
struct Matcher {
    vars: HashMap<String, String>,
    /// `<page:1>` → the id seen in its place, and back.
    tokens: HashMap<String, String>,
    values: HashMap<String, String>,
}

fn is_id_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// A normalizer token at the start of `text`: `<kind:N>` (an id, the same
/// value wherever it appears) or `<word>` (a value that differs run to run).
fn token_at(text: &str) -> Option<(&str, bool)> {
    let end = text.find('>')?;
    let inner = text.strip_prefix('<')?.get(..end - 1)?;
    let word = |w: &str| !w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase() || c == '-');
    match inner.split_once(':') {
        Some((kind, n)) => {
            (word(kind) && !n.is_empty() && n.chars().all(|c| c.is_ascii_digit())).then(|| (&text[..=end], true))
        }
        None => word(inner).then(|| (&text[..=end], false)),
    }
}

impl Matcher {
    /// `{name}` filled in from the variables; unknown names stay.
    fn fill(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for (name, value) in &self.vars {
            out = out.replace(&format!("{{{name}}}"), value);
        }
        out
    }

    fn text(&mut self, recorded: &str, actual: &str) -> bool {
        let recorded = self.fill(recorded);
        self.rest(&recorded, actual)
    }

    /// Whether `got` reads as `rest`, tokens standing for the values in their place.
    fn rest(&mut self, rest: &str, got: &str) -> bool {
        let Some(at) = rest.char_indices().map(|(at, _)| at).find(|at| token_at(&rest[*at..]).is_some()) else {
            return rest == got;
        };
        let Some(got) = got.strip_prefix(&rest[..at]) else { return false };
        let Some((token, id)) = token_at(&rest[at..]) else { return false };
        let after = &rest[at + token.len()..];
        // Text that only looks like a token (`<br>` in a page) is itself.
        if got.strip_prefix(token).is_some_and(|got| self.rest(after, got)) {
            return true;
        }
        if let Some(bound) = self.tokens.get(token).cloned() {
            return got.strip_prefix(bound.as_str()).is_some_and(|got| self.rest(after, got));
        }
        if id {
            let run: String = got.chars().take_while(|c| is_id_char(*c)).collect();
            if run.is_empty() || self.values.contains_key(&run) {
                return false;
            }
            self.tokens.insert(token.to_owned(), run.clone());
            self.values.insert(run.clone(), token.to_owned());
            return self.rest(after, &got[run.len()..]);
        }
        // A value of the run (a time, a random name): any length that lets the rest read.
        let longest = got.find(|c: char| !(is_id_char(c) || matches!(c, '.' | ':' | '+'))).unwrap_or(got.len());
        (1..=longest).rev().filter(|n| got.is_char_boundary(*n)).any(|n| self.rest(after, &got[n..]))
    }

    fn value(&mut self, recorded: &Value, actual: &Value, at: &str, out: &mut Vec<String>) {
        let same = match (recorded, actual) {
            (Value::String(r), Value::Number(_)) => r == "<now>",
            (Value::String(r), Value::String(a)) => self.text(r, a),
            (Value::Object(r), Value::Object(a)) => {
                for key in r.keys().chain(a.keys().filter(|k| !r.contains_key(*k))) {
                    match (r.get(key), a.get(key)) {
                        (Some(r), Some(a)) => self.value(r, a, &format!("{at}/{key}"), out),
                        (Some(_), None) => out.push(format!("{at}/{key}: missing")),
                        (None, _) => out.push(format!("{at}/{key}: not in the recording")),
                    }
                }
                true
            }
            (Value::Array(r), Value::Array(a)) if r.len() == a.len() => {
                for (i, (r, a)) in r.iter().zip(a).enumerate() {
                    self.value(r, a, &format!("{at}/{i}"), out);
                }
                true
            }
            (r, a) => r == a,
        };
        if !same {
            out.push(format!("{at}: recorded {recorded} got {actual}"));
        }
    }
}

fn encode(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The strings of a request body with the variables filled in.
fn filled(value: &Value, matcher: &Matcher) -> Value {
    match value {
        Value::String(s) => Value::String(matcher.fill(s)),
        Value::Array(items) => Value::Array(items.iter().map(|v| filled(v, matcher)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), filled(v, matcher))).collect()),
        other => other.clone(),
    }
}

impl Replay<'_> {
    /// Runs the steps of the recorded `scenario` in order.
    pub async fn run(&self, scenario: &str) -> Replayed {
        self.run_recording(&recording(scenario)).await
    }

    /// Runs the steps of a recording read from elsewhere (one made on a
    /// private copy of real data).
    pub async fn run_recording(&self, recording: &Value) -> Replayed {
        let mut matcher = Matcher::default();
        matcher.vars.extend(self.vars.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())));
        let mut replayed = Replayed::default();

        let seen: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let sink = seen.clone();
        let _events = self.bus.on(Filter::All, move |event| {
            let payload = serde_json::from_slice(&event.payload).unwrap_or(Value::Null);
            sink.lock().expect("events").push((event.topic.to_string(), payload));
        });
        // The topics the scenario's stream asked for (`pages:*`).
        let mut prefixes: Vec<String> = Vec::new();

        for exchange in recording["exchanges"].as_array().expect("exchanges") {
            let (step, recorded) = (&exchange["step"], &exchange["response"]);
            let name = step["name"].as_str().unwrap_or_default();
            if step.get("open").is_some() {
                let topics = step["query"]["topics"].as_str().unwrap_or_default();
                prefixes = topics.split(',').map(|t| t.trim_end_matches('*').to_owned()).collect();
                continue;
            }
            let Some(request) = step["request"].as_str() else { continue };
            if self.skip.contains(&name) || !(self.only.is_empty() || self.only.contains(&name)) {
                continue;
            }
            self.clock.advance(1000);
            replayed.steps += 1;
            let mut differences = Vec::new();

            let (method, path) = request.split_once(' ').expect("METHOD /path");
            let mut target = matcher.fill(path);
            if let Some(query) = step["query"].as_object() {
                let pairs: Vec<String> = query
                    .iter()
                    .map(|(k, v)| format!("{}={}", encode(k), encode(&matcher.fill(v.as_str().unwrap_or_default()))))
                    .collect();
                target = format!("{target}?{}", pairs.join("&"));
            }
            let caller = if step["auth"] == "none" { Caller::UNTRUSTED } else { Caller::DASHBOARD };
            let mut req = Request::new(Method::parse(method).expect("a method"), &target, caller);
            for (header, value) in step["headers"].as_object().into_iter().flatten() {
                req = req.header(header, value.as_str().unwrap_or_default());
            }
            if let Some(body) = step.get("body") {
                req = req.body(serde_json::to_vec(&filled(body, &matcher)).expect("json"));
            } else if let Some(text) = step["text"].as_str() {
                req = req.body(text.as_bytes().to_vec());
            } else if let Some(encoded) = step["base64"].as_str() {
                req = req.body(base64::engine::general_purpose::STANDARD.decode(encoded).expect("base64"));
            }

            seen.lock().expect("events").clear();
            let response = self.router.handle(req).await;
            self.bus.flush().await;
            let status = response.status;
            let content_type = response.header_value("content-type").map(str::to_owned);
            let body = response.body.collect().await.expect("a body");

            if recorded["status"] != status {
                differences.push(format!("/status: recorded {} got {status}", recorded["status"]));
            }
            if let Some(recorded_type) = recorded["headers"]["content-type"].as_str()
                && content_type.as_deref() != Some(recorded_type)
            {
                differences.push(format!("/headers/content-type: recorded {recorded_type} got {content_type:?}"));
            }
            let json: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            if let Some(recorded_json) = recorded.get("json") {
                matcher.value(recorded_json, &json, "/json", &mut differences);
            } else if let Some(sha) = recorded["sha256"].as_str() {
                let got: String = Sha256::digest(&body).iter().map(|b| format!("{b:02x}")).collect();
                if got != sha || recorded["bytes"] != body.len() {
                    differences.push(format!(
                        "/bytes: recorded {} bytes {sha}, got {} bytes {got}",
                        recorded["bytes"],
                        body.len()
                    ));
                }
            }
            for (var, pointer) in step["capture"].as_object().into_iter().flatten() {
                let pointer = pointer.as_str().unwrap_or_default().trim_start_matches("/json");
                if let Some(value) = json.pointer(pointer).and_then(Value::as_str) {
                    matcher.vars.insert(var.clone(), value.to_owned());
                }
            }

            let recorded_events: Vec<&Value> = recorded["frames"]
                .as_object()
                .into_iter()
                .flat_map(|streams| streams.values())
                .flat_map(|frames| frames.as_array().into_iter().flatten())
                .filter(|frame| frame["data"]["reason"].is_string())
                .map(|frame| &frame["data"])
                .collect();
            let events: Vec<(String, Value)> = seen
                .lock()
                .expect("events")
                .iter()
                .filter(|(topic, _)| prefixes.iter().any(|prefix| topic.starts_with(prefix.as_str())))
                .cloned()
                .collect();
            if recorded_events.len() != events.len() {
                let got: Vec<&str> = events.iter().map(|(topic, _)| topic.as_str()).collect();
                differences.push(format!("/frames: recorded {} events, got {got:?}", recorded_events.len()));
            } else {
                for (i, (recorded_event, (topic, payload))) in recorded_events.iter().zip(&events).enumerate() {
                    if recorded_event["reason"] != topic.as_str() {
                        differences
                            .push(format!("/frames/{i}/reason: recorded {} got {topic}", recorded_event["reason"]));
                    }
                    matcher.value(
                        &recorded_event["payload"],
                        payload,
                        &format!("/frames/{i}/payload"),
                        &mut differences,
                    );
                }
            }
            replayed.differences.extend(differences.into_iter().map(|d| format!("{name}: {d}")));
        }
        replayed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn id_tokens_bind_to_the_first_value_and_stay() {
        let mut m = Matcher::default();
        m.vars.insert("sandbox".into(), "/tmp/s".into());
        assert!(m.text("page <page:1> changed (now rev 2)", "page pg-0001 changed (now rev 2)"));
        assert!(m.text("<page:1>", "pg-0001"));
        assert!(!m.text("<page:1>", "pg-0002"), "bound already");
        assert!(!m.text("<page:2>", "pg-0001"), "one value, one token");
        assert!(m.text("{sandbox}/alpha", "/tmp/s/alpha"));
        assert!(m.text("a < b", "a < b"));
        assert!(!m.text("abc", "abcd"));
        assert!(m.text(
            "in /tmp/eos-paste-<random>/a.png at <now>.",
            "in /tmp/eos-paste-Ab12Cd/a.png at 2026-11-11T10:00:00.000Z."
        ));
        assert!(!m.text("eos-paste-<random>/a", "eos-paste-/a"));
        assert!(m.text("line<br>break <b>bold</b>", "line<br>break <b>bold</b>"));

        let mut out = Vec::new();
        m.value(
            &json!({"at": "<now>", "ids": ["<page:1>", "<page:2>"]}),
            &json!({"at": 5, "ids": ["pg-0001", "pg-0002"]}),
            "",
            &mut out,
        );
        assert!(out.is_empty(), "{out:?}");
        m.value(&json!({"a": 1, "b": 2}), &json!({"a": 2, "c": 3}), "", &mut out);
        assert_eq!(out, ["/a: recorded 1 got 2", "/b: missing", "/c: not in the recording"]);
    }
}
