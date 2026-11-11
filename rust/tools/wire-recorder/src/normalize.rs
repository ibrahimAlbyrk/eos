//! Makes two runs of the same scenario read the same: times, generated ids,
//! ports, absolute paths and unordered lists are rewritten by rules that live
//! in a data file (`normalize.toml`), not in code.
//!
//! A response is one JSON document: `status`, `headers`, then `json` / `text` /
//! `bytes` + `sha256`, and `frames` per open stream. Rules address it by pointer.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Context, bail};
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::clock;

/// The rule file.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rules {
    /// Response headers a recording keeps; every other header is dropped.
    #[serde(default)]
    pub headers: Vec<String>,
    #[serde(default)]
    pub stream: StreamRules,
    #[serde(default, rename = "rule")]
    pub rules: Vec<Rule>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamRules {
    /// Comment lines left out (the keepalive).
    #[serde(default)]
    pub ignore_comments: Vec<String>,
}

/// Where a rule applies (every given selector must hold) and the one thing it does.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    /// Why the rule exists; for readers of the file.
    pub about: Option<String>,
    /// Glob over `"METHOD /path/template"` (`*` within a segment, `**` across).
    pub route: Option<String>,
    /// Glob over a frame's reason; `at` is then relative to that frame. With
    /// `drop` and no `at`, the frame itself goes.
    pub reason: Option<String>,
    /// Pointer glob (`*` one segment, `**` any number).
    pub at: Option<String>,
    /// Object keys, at any depth.
    #[serde(default)]
    pub key: Vec<String>,
    /// The whole string value must match.
    pub matches: Option<String>,

    /// Replace the value.
    pub set: Option<Value>,
    /// Replace a string (`matches`) or each `find` hit inside strings by `<name:N>`:
    /// the same N for the same text across the scenario.
    pub token: Option<String>,
    /// Rewrite inside strings: `find` is a pattern, `replace` its replacement.
    pub find: Option<String>,
    pub replace: Option<String>,
    /// Replace wall-clock times of this run by this text: epoch numbers, and ISO
    /// dates and epoch milliseconds inside strings, within two days of now.
    /// Times that were seeded stay as they are.
    pub now: Option<String>,
    /// Sort an array by the value at this pointer inside each element ("" = the element).
    pub sort_by: Option<String>,
    /// Keep only the type skeleton (keys and value types).
    #[serde(default)]
    pub shape: bool,
    /// Remove the value from its parent.
    #[serde(default)]
    pub drop: bool,
    /// Keep the first of each run of consecutive frames with this `reason`:
    /// how many chunks an output arrives in depends on timing.
    #[serde(default)]
    pub collapse: bool,
}

#[derive(Debug)]
enum Action {
    Set(Value),
    Token(String),
    TokenIn(Regex, String),
    Replace(Regex, String),
    Now(String),
    SortBy(String),
    Shape,
    Drop,
    Collapse,
}

#[derive(Debug)]
struct Compiled {
    route: Option<Regex>,
    reason: Option<Regex>,
    at: Option<Vec<String>>,
    key: Vec<String>,
    matches: Option<Regex>,
    action: Action,
}

impl Compiled {
    fn new(rule: &Rule) -> anyhow::Result<Self> {
        let mut actions = Vec::new();
        if let Some(value) = &rule.set {
            actions.push(Action::Set(value.clone()));
        }
        match (&rule.token, &rule.find, &rule.replace) {
            (Some(name), Some(find), None) => actions.push(Action::TokenIn(Regex::new(find)?, name.clone())),
            (Some(name), None, None) => actions.push(Action::Token(name.clone())),
            (None, Some(find), Some(replace)) => actions.push(Action::Replace(Regex::new(find)?, replace.clone())),
            (None, None, None) => {}
            _ => bail!("find goes with replace or with token"),
        }
        if let Some(text) = &rule.now {
            actions.push(Action::Now(text.clone()));
        }
        if let Some(pointer) = &rule.sort_by {
            actions.push(Action::SortBy(pointer.clone()));
        }
        if rule.shape {
            actions.push(Action::Shape);
        }
        if rule.drop {
            actions.push(Action::Drop);
        }
        if rule.collapse {
            if rule.reason.is_none() {
                bail!("collapse needs a reason");
            }
            actions.push(Action::Collapse);
        }
        let Some(action) = actions.pop().filter(|_| actions.is_empty()) else {
            bail!("a rule does exactly one of set, token, find/replace, now, sort_by, shape, drop, collapse");
        };
        Ok(Self {
            route: rule.route.as_deref().map(glob).transpose()?,
            reason: rule.reason.as_deref().map(glob).transpose()?,
            at: rule.at.as_ref().map(|at| at.split('/').skip(1).map(str::to_owned).collect()),
            key: rule.key.clone(),
            matches: rule.matches.as_ref().map(|m| Regex::new(&format!("^(?:{m})$"))).transpose()?,
            action,
        })
    }

    /// Rules that name no place also rewrite object keys (maps keyed by an id).
    fn renames_keys(&self) -> bool {
        self.at.is_none()
            && self.key.is_empty()
            && matches!(self.action, Action::Token(_) | Action::TokenIn(..) | Action::Replace(..))
    }

    fn hits(&self, path: &[String], node: &Value) -> bool {
        if let Some(at) = &self.at
            && !pointer_matches(at, path)
        {
            return false;
        }
        if !self.key.is_empty() && !path.last().is_some_and(|last| self.key.contains(last)) {
            return false;
        }
        match (&self.matches, node) {
            (Some(pattern), Value::String(s)) => pattern.is_match(s),
            (Some(_), _) => false,
            (None, _) => true,
        }
    }
}

/// `*` stays inside a path segment, `**` crosses segments.
fn glob(pattern: &str) -> anyhow::Result<Regex> {
    let mut out = String::from("^");
    let mut rest = pattern;
    while !rest.is_empty() {
        if let Some(tail) = rest.strip_prefix("**") {
            out.push_str(".*");
            rest = tail;
        } else if let Some(tail) = rest.strip_prefix('*') {
            out.push_str("[^/]*");
            rest = tail;
        } else {
            let end = rest.find('*').unwrap_or(rest.len());
            out.push_str(&regex::escape(&rest[..end]));
            rest = &rest[end..];
        }
    }
    out.push('$');
    Ok(Regex::new(&out)?)
}

fn pointer_matches(pattern: &[String], path: &[String]) -> bool {
    match pattern.split_first() {
        None => path.is_empty(),
        Some((first, rest)) if first == "**" => (0..=path.len()).any(|skip| pointer_matches(rest, &path[skip..])),
        Some((first, rest)) => match path.split_first() {
            Some((segment, tail)) => (first == "*" || first == segment) && pointer_matches(rest, tail),
            None => false,
        },
    }
}

/// Applies the rules to every response of one scenario, numbering tokens across them.
#[derive(Debug)]
pub struct Normalizer {
    headers: Vec<String>,
    stream: StreamRules,
    rules: Vec<Compiled>,
    /// Run-specific values (paths, the data folder) and the `{name}` written instead; longest first.
    known: Vec<(String, String)>,
    tokens: BTreeMap<(String, String), usize>,
    counters: BTreeMap<String, usize>,
    /// Epoch milliseconds of this run, for `now` rules.
    now_ms: i64,
}

impl Normalizer {
    /// `now_ms`: the wall clock of the run (epoch milliseconds).
    pub fn new(rules: &Rules, known: &BTreeMap<String, String>, now_ms: i64) -> anyhow::Result<Self> {
        let compiled = rules
            .rules
            .iter()
            .enumerate()
            .map(|(i, rule)| {
                let about = rule.about.as_deref().unwrap_or("no about");
                Compiled::new(rule).with_context(|| format!("rule {} ({about})", i + 1))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        // Short values (a port, a name) would hit unrelated text.
        let mut known: Vec<(String, String)> = known
            .iter()
            .filter(|(_, value)| value.len() >= 6)
            .map(|(name, value)| (value.clone(), format!("{{{name}}}")))
            .collect();
        known.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.cmp(b)));
        Ok(Self {
            headers: rules.headers.clone(),
            stream: rules.stream.clone(),
            rules: compiled,
            known,
            tokens: BTreeMap::new(),
            counters: BTreeMap::new(),
            now_ms,
        })
    }

    /// Loads the rule file for a run that happens now.
    pub fn load(path: &Path, known: &BTreeMap<String, String>) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        let rules: Rules = toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?;
        Self::new(&rules, known, i64::try_from(now.as_millis())?).with_context(|| format!("in {}", path.display()))
    }

    /// `route` is `"METHOD /path/template"` as the scenario wrote it.
    pub fn normalize(&mut self, route: &str, extra_headers: &[String], mut response: Value) -> Value {
        self.keep_headers(&mut response, extra_headers);
        self.drop_stream_noise(&mut response);
        substitute(&mut response, &self.known);
        let Self { rules, tokens, counters, now_ms, .. } = self;
        let mut table = Tokens { seen: tokens, counters, now_ms: *now_ms };
        for rule in rules.iter().filter(|rule| rule.route.as_ref().is_none_or(|r| r.is_match(route))) {
            let Some(reason) = &rule.reason else {
                walk(rule, &mut table, &mut response, &mut Vec::new());
                continue;
            };
            let named = |frame: &Value| {
                frame.pointer("/data/reason").and_then(Value::as_str).is_some_and(|r| reason.is_match(r))
            };
            for frames in streams_mut(&mut response) {
                match &rule.action {
                    Action::Drop if rule.at.is_none() && rule.key.is_empty() => frames.retain(|frame| !named(frame)),
                    Action::Collapse => {
                        let mut in_run = false;
                        frames.retain(|frame| {
                            let repeat = named(frame) && in_run;
                            in_run = named(frame);
                            !repeat
                        });
                    }
                    _ => {
                        for frame in frames.iter_mut().filter(|frame| named(frame)) {
                            walk(rule, &mut table, frame, &mut Vec::new());
                        }
                    }
                }
            }
        }
        response
    }

    fn keep_headers(&self, response: &mut Value, extra: &[String]) {
        if let Some(Value::Object(headers)) = response.get_mut("headers") {
            headers.retain(|name, _| self.headers.contains(name) || extra.contains(name));
        }
    }

    fn drop_stream_noise(&self, response: &mut Value) {
        let Some(Value::Object(streams)) = response.get_mut("frames") else { return };
        for frames in streams.values_mut() {
            let Value::Array(frames) = frames else { continue };
            frames.retain(|frame| {
                let comment = frame.get("comment").and_then(Value::as_str);
                !comment.is_some_and(|c| self.stream.ignore_comments.iter().any(|i| i == c))
            });
        }
    }
}

/// The frame list of each open stream.
fn streams_mut(response: &mut Value) -> impl Iterator<Item = &mut Vec<Value>> {
    let streams = match response.get_mut("frames") {
        Some(Value::Object(streams)) => Some(streams),
        _ => None,
    };
    streams.into_iter().flat_map(|s| s.values_mut()).filter_map(Value::as_array_mut)
}

struct Tokens<'a> {
    seen: &'a mut BTreeMap<(String, String), usize>,
    counters: &'a mut BTreeMap<String, usize>,
    now_ms: i64,
}

impl Tokens<'_> {
    fn name(&mut self, kind: &str, value: &str) -> String {
        let n = *self.seen.entry((kind.to_owned(), value.to_owned())).or_insert_with(|| {
            let counter = self.counters.entry(kind.to_owned()).or_insert(0);
            *counter += 1;
            *counter
        });
        format!("<{kind}:{n}>")
    }

    fn name_each(&mut self, find: &Regex, kind: &str, text: &str) -> String {
        find.replace_all(text, |hit: &regex::Captures<'_>| self.name(kind, &hit[0])).into_owned()
    }
}

fn substitute(node: &mut Value, known: &[(String, String)]) {
    let rewrite = |text: &str| known.iter().fold(text.to_owned(), |acc, (value, name)| acc.replace(value, name));
    match node {
        Value::String(s) => *s = rewrite(s),
        Value::Array(items) => items.iter_mut().for_each(|item| substitute(item, known)),
        Value::Object(map) => {
            let old = std::mem::take(map);
            for (key, mut value) in old {
                substitute(&mut value, known);
                map.insert(rewrite(&key), value);
            }
        }
        _ => {}
    }
}

fn walk(rule: &Compiled, tokens: &mut Tokens<'_>, node: &mut Value, path: &mut Vec<String>) {
    if rule.hits(path, node) {
        match &rule.action {
            Action::Set(value) => {
                *node = value.clone();
                return;
            }
            Action::Shape => {
                *node = shape(node);
                return;
            }
            Action::Token(kind) => {
                if let Value::String(s) = node {
                    *s = tokens.name(kind, s);
                }
                return;
            }
            Action::TokenIn(find, kind) => {
                if let Value::String(s) = node {
                    *s = tokens.name_each(find, kind, s);
                }
            }
            Action::Replace(find, replace) => {
                if let Value::String(s) = node {
                    *s = find.replace_all(s, replace.as_str()).into_owned();
                }
            }
            Action::Now(text) => match node {
                Value::Number(n) if n.as_f64().is_some_and(|n| clock::is_recent_epoch(n, tokens.now_ms)) => {
                    *node = Value::String(text.clone());
                    return;
                }
                Value::String(s) => *s = clock::replace_recent(s, tokens.now_ms, text),
                _ => {}
            },
            Action::SortBy(pointer) => {
                if let Value::Array(items) = node {
                    items.sort_by_cached_key(|item| sort_key(item.pointer(pointer).unwrap_or(&Value::Null)));
                }
            }
            // Done by the parent, which owns the slot.
            Action::Drop | Action::Collapse => {}
        }
    }
    match node {
        Value::Object(map) => {
            let old = std::mem::take(map);
            for (key, mut value) in old {
                path.push(key);
                let dropped = matches!(rule.action, Action::Drop) && rule.hits(path, &value);
                if !dropped {
                    walk(rule, tokens, &mut value, path);
                }
                let key = path.pop().unwrap_or_default();
                if !dropped {
                    map.insert(rename_key(rule, tokens, key), value);
                }
            }
        }
        Value::Array(items) => {
            let old = std::mem::take(items);
            for (index, mut value) in old.into_iter().enumerate() {
                path.push(index.to_string());
                let dropped = matches!(rule.action, Action::Drop) && rule.hits(path, &value);
                if !dropped {
                    walk(rule, tokens, &mut value, path);
                    items.push(value);
                }
                path.pop();
            }
        }
        _ => {}
    }
}

fn rename_key(rule: &Compiled, tokens: &mut Tokens<'_>, key: String) -> String {
    if !rule.renames_keys() {
        return key;
    }
    match &rule.action {
        Action::Token(kind) if rule.matches.as_ref().is_some_and(|m| m.is_match(&key)) => tokens.name(kind, &key),
        Action::TokenIn(find, kind) => tokens.name_each(find, kind, &key),
        Action::Replace(find, replace) => find.replace_all(&key, replace.as_str()).into_owned(),
        _ => key,
    }
}

fn sort_key(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Keys and value types, without the values.
fn shape(value: &Value) -> Value {
    match value {
        Value::Null => Value::Null,
        Value::Bool(_) => "<bool>".into(),
        Value::Number(_) => "<number>".into(),
        Value::String(_) => "<string>".into(),
        Value::Array(items) => {
            let mut shapes: Vec<Value> = Vec::new();
            for item in items {
                let s = shape(item);
                if !shapes.contains(&s) {
                    shapes.push(s);
                }
            }
            shapes.sort_by_key(Value::to_string);
            Value::Array(shapes)
        }
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), shape(v))).collect::<Map<_, _>>()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    /// 2026-11-11T12:00:00Z.
    const NOW: i64 = 1_794_398_400_000;

    fn normalizer(rules: &str) -> Normalizer {
        let rules: Rules = toml::from_str(rules).expect("rules parse");
        let known =
            BTreeMap::from([("home".to_owned(), "/tmp/run/home".to_owned()), ("port".to_owned(), "7500".to_owned())]);
        Normalizer::new(&rules, &known, NOW).expect("rules compile")
    }

    #[test]
    fn keeps_listed_headers_and_writes_known_values_as_variables() {
        let mut n = normalizer("headers = [\"content-type\"]");
        let out = n.normalize(
            "GET /x",
            &["etag".into()],
            json!({"headers": {"content-type": "a", "date": "b", "etag": "c"}, "json": {"path": "/tmp/run/home/pages", "/tmp/run/home": 7500}}),
        );
        assert_eq!(
            out,
            json!({"headers": {"content-type": "a", "etag": "c"}, "json": {"path": "{home}/pages", "{home}": 7500}})
        );
    }

    #[test]
    fn sets_by_key_and_by_route_pointer() {
        let mut n = normalizer(
            r#"
            [[rule]]
            key = ["ts", "createdAt"]
            set = "<ms>"
            [[rule]]
            route = "GET /health"
            at = "/json/pid"
            set = "<pid>"
            [[rule]]
            route = "* /workers/*/events"
            at = "/json/*/seq"
            set = 0
            "#,
        );
        assert_eq!(
            n.normalize(
                "GET /health",
                &[],
                json!({"json": {"pid": 12, "ts": 5, "deep": [{"createdAt": 9, "pid": 3}]}})
            ),
            json!({"json": {"pid": "<pid>", "ts": "<ms>", "deep": [{"createdAt": "<ms>", "pid": 3}]}})
        );
        assert_eq!(n.normalize("GET /other", &[], json!({"json": {"pid": 12}})), json!({"json": {"pid": 12}}));
        assert_eq!(
            n.normalize("GET /workers/{w}/events", &[], json!({"json": [{"seq": 4}, {"seq": 5}]})),
            json!({"json": [{"seq": 0}, {"seq": 0}]})
        );
    }

    #[test]
    fn numbers_tokens_by_first_sight_across_responses_and_in_keys() {
        let mut n = normalizer(
            r#"
            [[rule]]
            matches = 'w-[0-9a-f]{4}'
            token = "worker"
            "#,
        );
        let first =
            n.normalize("GET /a", &[], json!({"json": [{"id": "w-00aa"}, {"id": "w-00bb", "parent": "w-00aa"}]}));
        assert_eq!(first, json!({"json": [{"id": "<worker:1>"}, {"id": "<worker:2>", "parent": "<worker:1>"}]}));
        let second = n.normalize(
            "GET /b",
            &[],
            json!({"json": {"w-00bb": 1, "note": "w-00bb is not a whole match", "x": "w-00cc"}}),
        );
        assert_eq!(
            second,
            json!({"json": {"<worker:2>": 1, "note": "w-00bb is not a whole match", "x": "<worker:3>"}})
        );
    }

    #[test]
    fn tokens_inside_strings_share_the_numbering() {
        let mut n = normalizer(
            r#"
            [[rule]]
            find = '\bw-[0-9a-z]{8}\b'
            token = "worker"
            "#,
        );
        assert_eq!(
            n.normalize("GET /a", &[], json!({"json": {"id": "w-abcd1234", "payload": "{\"from\":\"w-zzzz0000\",\"to\":\"w-abcd1234\"}", "w-zzzz0000": "w-SEEDED"}})),
            json!({"json": {"id": "<worker:1>", "payload": "{\"from\":\"<worker:2>\",\"to\":\"<worker:1>\"}", "<worker:2>": "w-SEEDED"}})
        );
    }

    #[test]
    fn replaces_times_of_this_run_and_keeps_seeded_ones() {
        let mut n = normalizer("[[rule]]\nnow = \"<now>\"");
        let out = n.normalize(
            "GET /a",
            &[],
            json!({"json": {
                "startedAt": NOW - 5_000,
                "seconds": NOW / 1000 + 60,
                "seeded": 1_790_000_000_000_i64,
                "count": 42,
                "iso": "2026-11-11T11:59:58.120Z",
                "local": "at 2026-11-11 14:59:58 UTC+03:00, id 1794398399000",
                "offset": "2026-11-11T14:59:58.120+03:00",
                "old": "2026-09-01T10:00:00Z and 1790000000000",
            }}),
        );
        assert_eq!(
            out,
            json!({"json": {
                "startedAt": "<now>",
                "seconds": "<now>",
                "seeded": 1_790_000_000_000_i64,
                "count": 42,
                "iso": "<now>",
                "local": "at <now> UTC+03:00, id <now>",
                "offset": "<now>",
                "old": "2026-09-01T10:00:00Z and 1790000000000",
            }})
        );
    }

    #[test]
    fn rewrites_inside_strings() {
        let mut n = normalizer(
            r#"
            [[rule]]
            find = '\d{4}-\d\d-\d\dT[\d:.]+Z'
            replace = "<iso>"
            [[rule]]
            route = "GET /metrics"
            at = "/text"
            find = '(?m)^(eos_\w+) \d+$'
            replace = "$1 <n>"
            "#,
        );
        assert_eq!(
            n.normalize(
                "GET /metrics",
                &[],
                json!({"text": "eos_up 12\neos_x 3", "json": {"at": "since 2026-11-11T11:20:30.190Z"}})
            ),
            json!({"text": "eos_up <n>\neos_x <n>", "json": {"at": "since <iso>"}})
        );
    }

    #[test]
    fn sorts_shapes_and_drops() {
        let mut n = normalizer(
            r#"
            [[rule]]
            at = "/json/entries"
            sort_by = "/name"
            [[rule]]
            at = "/json/editors"
            shape = true
            [[rule]]
            key = ["mtime"]
            drop = true
            [[rule]]
            at = "/json/list/*"
            matches = "noise"
            drop = true
            "#,
        );
        let out = n.normalize(
            "GET /x",
            &[],
            json!({"json": {
                "entries": [{"name": "b", "mtime": 1}, {"name": "a", "mtime": 2}],
                "editors": [{"id": "vscode", "n": 1}, {"id": "xcode", "n": 2}, {"id": "x", "extra": null}],
                "list": ["keep", "noise", "also"],
            }}),
        );
        assert_eq!(
            out,
            json!({"json": {
                "entries": [{"name": "a"}, {"name": "b"}],
                "editors": [{"extra": null, "id": "<string>"}, {"id": "<string>", "n": "<number>"}],
                "list": ["keep", "also"],
            }})
        );
    }

    #[test]
    fn frame_rules_and_stream_noise() {
        let mut n = normalizer(
            r#"
            [stream]
            ignore_comments = ["ka"]
            [[rule]]
            reason = "usage:change"
            drop = true
            [[rule]]
            route = "POST /terminal"
            reason = "jobs:change"
            drop = true
            [[rule]]
            reason = "terminal:chunk"
            collapse = true
            [[rule]]
            reason = "pages:*"
            at = "/data/payload/rev"
            set = "<rev>"
            "#,
        );
        let frames = json!({"frames": {"main": [
            {"comment": "ka"},
            {"data": {"reason": "usage:change", "payload": {}}},
            {"data": {"reason": "jobs:change", "payload": {}}},
            {"data": {"reason": "terminal:chunk", "payload": {"n": 1}}},
            {"data": {"reason": "terminal:chunk", "payload": {"n": 2}}},
            {"data": {"reason": "pages:change", "payload": {"rev": 3}}},
            {"data": {"reason": "terminal:chunk", "payload": {"n": 3}}},
            {"data": {"reason": "worker:change", "payload": {"rev": 3}}},
        ]}});
        assert_eq!(
            n.normalize("POST /api/pages", &[], frames.clone()),
            json!({"frames": {"main": [
                {"data": {"reason": "jobs:change", "payload": {}}},
                {"data": {"reason": "terminal:chunk", "payload": {"n": 1}}},
                {"data": {"reason": "pages:change", "payload": {"rev": "<rev>"}}},
                {"data": {"reason": "terminal:chunk", "payload": {"n": 3}}},
                {"data": {"reason": "worker:change", "payload": {"rev": 3}}},
            ]}})
        );
        let on_terminal = n.normalize("POST /terminal", &[], frames);
        assert_eq!(on_terminal["frames"]["main"].as_array().map(Vec::len), Some(4));
    }

    #[test]
    fn refuses_a_rule_with_no_or_two_actions() {
        for text in [
            "[[rule]]\nkey = [\"a\"]",
            "[[rule]]\nset = 1\ndrop = true",
            "[[rule]]\nfind = \"a\"",
            "[[rule]]\nnow = \"x\"\nshape = true",
        ] {
            let rules: Rules = toml::from_str(text).expect("parses");
            assert!(Normalizer::new(&rules, &BTreeMap::new(), NOW).is_err(), "{text}");
        }
    }

    #[test]
    fn pointer_globs() {
        let p = |s: &str| s.split('/').skip(1).map(str::to_owned).collect::<Vec<_>>();
        assert!(pointer_matches(&p("/json/*/id"), &p("/json/3/id")));
        assert!(!pointer_matches(&p("/json/*/id"), &p("/json/3/x/id")));
        assert!(pointer_matches(&p("/json/**/id"), &p("/json/3/x/id")));
        assert!(pointer_matches(&p("/json/**/id"), &p("/json/id")));
        assert!(pointer_matches(&p("/**"), &p("/a/b")));
        assert!(!pointer_matches(&p("/json"), &p("/json/a")));
    }
}
