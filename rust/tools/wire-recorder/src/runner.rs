//! Walks a scenario's steps against a target and returns the raw answers.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Context, bail};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::model::{Auth, Step};
use crate::sse::SseItem;
use crate::target::{Request, Response, Stream, Target};
use crate::vars::{Missing, Vars, select};

/// How a run talks and waits.
#[derive(Debug, Clone)]
pub struct Settings {
    /// Sent as `x-eos-ui-token` on steps whose `auth` is `ui`.
    pub token: Option<String>,
    /// Quiet time on the open streams after which a step's frames are complete.
    pub settle: Duration,
    /// How long a step waits for the reasons it names in `wait`.
    pub wait_timeout: Duration,
    /// The target serves a real data folder (session ids and paths of real chats):
    /// only reads are sent. Anything else is refused here, whatever the scenario says,
    /// because a message, spawn, resume or compaction would start an agent on real data.
    pub real_data: bool,
}

/// What one step produced.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Answered {
        /// The un-normalized response document.
        response: Value,
        method: String,
        /// The concrete path (variables filled, no query).
        path: String,
    },
    /// A variable the step needs was never captured.
    Skipped { missing: String },
}

/// A request still waiting for its answer, with the method and path it went to.
type Detached = (JoinHandle<anyhow::Result<Response>>, String, String);

pub struct Runner<'a> {
    target: &'a mut dyn Target,
    settings: Settings,
    vars: Vars,
    streams: BTreeMap<String, Stream>,
    /// Requests sent with `detach`, by step name.
    detached: BTreeMap<String, Detached>,
}

impl std::fmt::Debug for Runner<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runner")
            .field("settings", &self.settings)
            .field("streams", &self.streams)
            .finish_non_exhaustive()
    }
}

impl<'a> Runner<'a> {
    pub fn new(target: &'a mut dyn Target, settings: Settings, vars: Vars) -> Self {
        Self { target, settings, vars, streams: BTreeMap::new(), detached: BTreeMap::new() }
    }

    pub fn step(&mut self, step: &Step) -> anyhow::Result<Outcome> {
        if self.settings.real_data && !step.only_reads() {
            bail!(
                "refused: {:?} is not a read, and the target serves real data",
                step.request.as_deref().unwrap_or_default()
            );
        }
        if let Some(ms) = step.pause_ms {
            std::thread::sleep(Duration::from_millis(ms));
        }
        if let Some(name) = &step.close {
            // Every step already waited for its own frames; a straggler after the
            // last one would be there on one run and missing on the next.
            self.streams.remove(name).with_context(|| format!("no open stream named {name}"))?;
            let response = json!({ "closed": name });
            return Ok(Outcome::Answered { response, method: "CLOSE".into(), path: "/stream".into() });
        }
        if let Some(name) = &step.join {
            let (handle, method, path) =
                self.detached.remove(name).with_context(|| format!("no detached step named {name}"))?;
            let answer = handle.join().map_err(|_| anyhow::anyhow!("the detached request panicked"))??;
            return self.answered(step, document(&answer), &method, path);
        }
        let (method, template) = match &step.open {
            Some(_) => ("GET", "/stream"),
            None => step.method_and_path()?,
        };
        let request = match self.request(step, method, template) {
            Ok(request) => request,
            Err(Missing(name)) => return Ok(Outcome::Skipped { missing: name }),
        };
        let path = request.target.split('?').next().unwrap_or_default().to_owned();

        let response = if let Some(name) = &step.open {
            if self.streams.contains_key(name) {
                bail!("stream {name} is already open");
            }
            let stream = self.target.open_stream(&request)?;
            let head = json!({ "status": stream.status, "headers": headers_json(&stream.headers) });
            self.streams.insert(name.clone(), stream);
            head
        } else if step.detach {
            let mut fork = self.target.fork();
            let handle = std::thread::spawn(move || fork.send(&request));
            self.detached.insert(step.name.clone(), (handle, method.to_owned(), path.clone()));
            json!({ "detached": true })
        } else {
            document(&self.target.send(&request)?)
        };
        self.answered(step, response, method, path)
    }

    /// Adds the frames the step caused and keeps what later steps need.
    fn answered(&mut self, step: &Step, mut response: Value, method: &str, path: String) -> anyhow::Result<Outcome> {
        // An answer the author did not expect will not be followed by the frames they named.
        let expected = step.status.is_none_or(|status| response["status"] == status);
        let frames = self.frames(if expected { &step.wait } else { &[] })?;
        if !frames.is_empty()
            && let Value::Object(map) = &mut response
        {
            map.insert("frames".into(), Value::Object(frames));
        }
        for (name, pointer) in &step.capture {
            if let Some(value) = select(&response, pointer) {
                self.vars.set(name, value.clone());
            }
        }
        Ok(Outcome::Answered { response, method: method.to_owned(), path })
    }

    fn request(&self, step: &Step, method: &str, template: &str) -> Result<Request, Missing> {
        let mut target = self.vars.text(template)?;
        for (i, (key, value)) in step.query.iter().enumerate() {
            target.push(if i == 0 { '?' } else { '&' });
            target.push_str(&encode_component(key));
            target.push('=');
            target.push_str(&encode_component(&self.vars.text(value)?));
        }
        let mut headers = Vec::new();
        let body = if let Some(body) = &step.body {
            Some(self.vars.json(body)?.to_string().into_bytes())
        } else if let Some(json) = &step.json {
            Some(self.vars.text(json)?.into_bytes())
        } else if let Some(text) = &step.text {
            Some(self.vars.text(text)?.into_bytes())
        } else {
            // Checked when the scenario was loaded.
            step.base64.as_deref().and_then(|encoded| crate::vars::base64_decode(encoded).ok())
        };
        if body.is_some() {
            let json = step.body.is_some() || step.json.is_some();
            let fallback = match (json, step.base64.is_some()) {
                (true, _) => "application/json",
                (_, true) => "application/octet-stream",
                _ => "text/plain",
            };
            let content_type = step.content_type.as_deref().unwrap_or(fallback);
            headers.push(("content-type".to_owned(), content_type.to_owned()));
        }
        if step.auth == Auth::Ui
            && let Some(token) = &self.settings.token
        {
            headers.push(("x-eos-ui-token".to_owned(), token.clone()));
        }
        for (name, value) in &step.headers {
            headers.push((name.clone(), self.vars.text(value)?));
        }
        Ok(Request { via: step.via, method: method.to_owned(), target, headers, body })
    }

    /// Collects what the open streams carried until they fall quiet and every
    /// reason in `wait` has been seen.
    fn frames(&mut self, wait: &[String]) -> anyhow::Result<Map<String, Value>> {
        let mut out: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        if self.streams.is_empty() {
            if !wait.is_empty() {
                bail!("the step waits for {wait:?} but no stream is open");
            }
            return Ok(Map::new());
        }
        let mut pending: Vec<&String> = wait.iter().collect();
        let started = Instant::now();
        let mut last = Instant::now();
        loop {
            for (name, stream) in &self.streams {
                while let Ok(item) = stream.items.try_recv() {
                    last = Instant::now();
                    if let SseItem::Event { id: Some(id), .. } = &item {
                        self.vars.set(format!("{name}.last_id"), Value::String(id.clone()));
                    }
                    if let Some(reason) = item.reason() {
                        pending.retain(|wanted| **wanted != reason);
                    }
                    out.entry(name.clone()).or_default().push(item.to_json());
                }
            }
            if pending.is_empty() && last.elapsed() >= self.settings.settle {
                break;
            }
            if !pending.is_empty() && started.elapsed() >= self.settings.wait_timeout {
                bail!("the stream never carried {pending:?}");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(out.into_iter().map(|(name, frames)| (name, Value::Array(frames))).collect())
    }
}

fn headers_json(headers: &[(String, String)]) -> Value {
    let mut map = Map::new();
    for (name, value) in headers {
        match map.get_mut(name) {
            // A repeated header reads as one comma-joined value.
            Some(Value::String(existing)) => {
                existing.push_str(", ");
                existing.push_str(value);
            }
            _ => {
                map.insert(name.clone(), Value::String(value.clone()));
            }
        }
    }
    Value::Object(map)
}

/// The response as one JSON document: `json` when the body is JSON, `text`
/// when it is text, else its size and hash.
fn document(response: &Response) -> Value {
    let mut doc = Map::new();
    doc.insert("status".into(), response.status.into());
    doc.insert("headers".into(), headers_json(&response.headers));
    if response.body.is_empty() {
        return Value::Object(doc);
    }
    let content_type = response
        .headers
        .iter()
        .find(|(name, _)| name == "content-type")
        .map(|(_, v)| v.to_ascii_lowercase())
        .unwrap_or_default();
    let text = std::str::from_utf8(&response.body).ok();
    let json = text
        .filter(|_| content_type.contains("json") || content_type.is_empty())
        .and_then(|t| serde_json::from_str(t).ok());
    let textual =
        ["text/", "json", "javascript", "xml", "x-www-form-urlencoded"].iter().any(|kind| content_type.contains(kind));
    match (json, text) {
        (Some(json), _) => {
            doc.insert("json".into(), json);
        }
        (None, Some(text)) if textual || content_type.is_empty() => {
            doc.insert("text".into(), text.into());
        }
        _ => {
            doc.insert("bytes".into(), response.body.len().into());
            doc.insert("sha256".into(), hex(&Sha256::digest(&response.body)).into());
        }
    }
    Value::Object(doc)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

fn encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;
    use crate::model::Via;

    /// Answers from a script and remembers what it was asked.
    #[derive(Default)]
    struct Scripted {
        answers: Vec<Response>,
        asked: Vec<Request>,
        feed: Option<mpsc::Sender<SseItem>>,
        /// Sent on the stream when a request arrives, as a daemon would.
        on_request: Vec<SseItem>,
    }

    impl Target for Scripted {
        fn send(&mut self, request: &Request) -> anyhow::Result<Response> {
            self.asked.push(request.clone());
            if let Some(feed) = &self.feed {
                for item in self.on_request.drain(..) {
                    feed.send(item).expect("stream open");
                }
            }
            Ok(self.answers.remove(0))
        }

        fn open_stream(&mut self, request: &Request) -> anyhow::Result<Stream> {
            self.asked.push(request.clone());
            let (tx, rx) = mpsc::channel();
            tx.send(SseItem::Comment("connected".into())).expect("receiver alive");
            tx.send(event("e-1", "hello", "{\"seq\":1}")).expect("receiver alive");
            self.feed = Some(tx);
            Ok(Stream::new(200, vec![("content-type".into(), "text/event-stream".into())], rx, || {}))
        }

        fn fork(&self) -> Box<dyn Target + Send> {
            Box::new(Scripted {
                answers: vec![answer(200, "application/json", b"{\"decision\":\"allow\"}")],
                ..Scripted::default()
            })
        }
    }

    fn event(id: &str, name: &str, data: &str) -> SseItem {
        SseItem::Event { id: Some(id.into()), event: Some(name.into()), data: data.into() }
    }

    fn answer(status: u16, content_type: &str, body: &[u8]) -> Response {
        Response { status, headers: vec![("content-type".into(), content_type.into())], body: body.to_vec() }
    }

    fn settings() -> Settings {
        Settings {
            token: Some("secret".into()),
            settle: Duration::from_millis(20),
            wait_timeout: Duration::from_millis(300),
            real_data: false,
        }
    }

    fn step(toml_text: &str) -> Step {
        toml::from_str(toml_text).expect("step parses")
    }

    #[test]
    fn sends_a_request_captures_and_reuses() {
        let mut target = Scripted {
            answers: vec![
                answer(200, "application/json", b"{\"page\":{\"id\":\"p 1\"}}"),
                answer(404, "text/plain", b"nope"),
            ],
            ..Scripted::default()
        };
        let mut runner = Runner::new(&mut target, settings(), Vars::default());
        let created = runner
            .step(&step(
                "name = \"create\"\nrequest = \"POST /api/pages\"\nstatus = 200\nbody = { title = \"T\" }\ncapture = { page = \"/json/page/id\" }",
            ))
            .expect("runs");
        assert_eq!(
            created,
            Outcome::Answered {
                response: json!({"status": 200, "headers": {"content-type": "application/json"}, "json": {"page": {"id": "p 1"}}}),
                method: "POST".into(),
                path: "/api/pages".into(),
            }
        );
        let read = runner
            .step(&step(
                "name = \"read\"\nrequest = \"GET /api/pages/{page}\"\nstatus = 404\nauth = \"none\"\nvia = \"socket\"\nquery = { q = \"{page}&x\" }",
            ))
            .expect("runs");
        let Outcome::Answered { response, path, .. } = read else { panic!("answered") };
        assert_eq!(response["text"], "nope");
        assert_eq!(path, "/api/pages/p 1");
        let missing = runner.step(&step("name = \"x\"\nrequest = \"GET /a/{unknown}\"\nstatus = 200")).expect("runs");
        assert_eq!(missing, Outcome::Skipped { missing: "unknown".into() });

        assert_eq!(target.asked.len(), 2);
        assert_eq!(target.asked[0].body.as_deref(), Some(&b"{\"title\":\"T\"}"[..]));
        assert_eq!(
            target.asked[0].headers,
            vec![
                ("content-type".to_owned(), "application/json".to_owned()),
                ("x-eos-ui-token".to_owned(), "secret".to_owned())
            ]
        );
        assert_eq!(target.asked[1].target, "/api/pages/p 1?q=p%201%26x");
        assert_eq!(target.asked[1].via, Via::Socket);
        assert!(target.asked[1].headers.is_empty());
    }

    #[test]
    fn records_stream_frames_per_step_and_the_last_id() {
        let mut target = Scripted {
            answers: vec![answer(200, "application/json", b"{}"), answer(200, "application/json", b"{}")],
            on_request: vec![event("e-2", "change", "{\"reason\":\"pages:change\",\"payload\":{}}")],
            ..Scripted::default()
        };
        let mut runner = Runner::new(&mut target, settings(), Vars::default());
        let opened =
            runner.step(&step("name = \"open\"\nopen = \"main\"\nquery = { topics = \"pages:*\" }")).expect("opens");
        let Outcome::Answered { response, .. } = opened else { panic!("answered") };
        assert_eq!(response["status"], 200);
        assert_eq!(
            response["frames"]["main"],
            json!([{"comment": "connected"}, {"id": "e-1", "event": "hello", "data": {"seq": 1}}])
        );
        let Outcome::Answered { response, .. } = runner
            .step(&step("name = \"create\"\nrequest = \"POST /api/pages\"\nstatus = 200\nwait = [\"pages:change\"]"))
            .expect("runs")
        else {
            panic!("answered")
        };
        assert_eq!(
            response["frames"]["main"],
            json!([{"id": "e-2", "event": "change", "data": {"reason": "pages:change", "payload": {}}}])
        );
        let Outcome::Answered { response, .. } =
            runner.step(&step("name = \"again\"\nrequest = \"GET /x/{main.last_id}\"\nstatus = 200")).expect("runs")
        else {
            panic!("answered")
        };
        assert_eq!(response.get("frames"), None);
        runner.step(&step("name = \"close\"\nclose = \"main\"")).expect("closes");
        assert_eq!(target.asked[0].target, "/stream?topics=pages%3A%2A");
        assert_eq!(target.asked[2].target, "/x/e-2");
    }

    #[test]
    fn a_detached_request_is_answered_at_its_join() {
        let mut target = Scripted { answers: vec![answer(200, "application/json", b"[]")], ..Scripted::default() };
        let mut runner = Runner::new(&mut target, settings(), Vars::default());
        let sent =
            runner.step(&step("name = \"ask\"\nrequest = \"POST /policy/decide\"\ndetach = true")).expect("sent");
        assert_eq!(
            sent,
            Outcome::Answered {
                response: json!({"detached": true}),
                method: "POST".into(),
                path: "/policy/decide".into()
            }
        );
        runner.step(&step("name = \"list\"\nrequest = \"GET /pending\"\nstatus = 200")).expect("runs");
        let Outcome::Answered { response, .. } = runner
            .step(&step("name = \"answer\"\njoin = \"ask\"\nstatus = 200\ncapture = { d = \"/json/decision\" }"))
            .expect("joined")
        else {
            panic!("answered")
        };
        assert_eq!(response["json"], json!({"decision": "allow"}));
        assert!(runner.step(&step("name = \"again\"\njoin = \"ask\"\nstatus = 200")).is_err());
    }

    #[test]
    fn fails_when_an_awaited_reason_never_arrives() {
        let mut target = Scripted { answers: vec![answer(200, "application/json", b"{}")], ..Scripted::default() };
        let mut runner = Runner::new(&mut target, settings(), Vars::default());
        runner.step(&step("name = \"open\"\nopen = \"main\"")).expect("opens");
        let err = runner
            .step(&step("name = \"x\"\nrequest = \"POST /x\"\nstatus = 200\nwait = [\"never:fires\"]"))
            .expect_err("times out");
        assert!(err.to_string().contains("never:fires"), "{err}");
    }

    #[test]
    fn on_real_data_only_reads_are_sent() {
        let mut target = Scripted { answers: vec![answer(200, "application/json", b"[]")], ..Scripted::default() };
        let mut runner = Runner::new(&mut target, Settings { real_data: true, ..settings() }, Vars::default());
        for request in [
            "POST /workers/w-1/message",
            "POST /workers",
            "POST /workers/w-1/resume",
            "PUT /workers/w-1/model",
            "DELETE /workers/w-1",
        ] {
            let err = runner
                .step(&step(&format!("name = \"x\"\nrequest = \"{request}\"\nstatus = 200")))
                .expect_err("refused");
            assert!(err.to_string().starts_with("refused"), "{err}");
        }
        runner.step(&step("name = \"open\"\nopen = \"main\"")).expect("a stream is a read");
        runner.step(&step("name = \"list\"\nrequest = \"GET /workers\"\nstatus = 200")).expect("a GET is a read");
        assert_eq!(target.asked.iter().map(|r| r.method.as_str()).collect::<Vec<_>>(), ["GET", "GET"]);
    }

    #[test]
    fn classifies_bodies() {
        assert_eq!(document(&answer(200, "text/html; charset=utf-8", b"<p>")).get("text"), Some(&json!("<p>")));
        let binary = document(&answer(200, "image/png", &[0x89, 0x50]));
        assert_eq!(binary["bytes"], 2);
        assert_eq!(binary["sha256"].as_str().map(str::len), Some(64));
        assert_eq!(document(&answer(200, "application/json", b"not json")).get("text"), Some(&json!("not json")));
        assert_eq!(document(&answer(204, "", b"")), json!({"status": 204, "headers": {"content-type": ""}}));
    }
}
