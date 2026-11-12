//! A Claude Code transcript (`~/.claude/projects/…/<id>.jsonl`) read as a
//! conversation (`core/src/domain/claude-transcript.ts`,
//! `manager/services/pty/transcriptRows.ts`).
//!
//! After rewinds the file is a tree of entries with abandoned branches left
//! in place; everything here shows the active branch only — the chain walked
//! back from the newest user or assistant entry. Rows have the shape of
//! worker events, so clients draw a Code-view pane's conversation (and a
//! Workflow agent's) with their worker conversation view. A row's id is its
//! entry's position in the file, so ids stay put while Claude appends.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use eos_contracts::{PtyConversationRow, PtyPending, PtyPendingName, parse_structured_patch};
use regress::Regex;
use serde_json::{Map, Value, json};

use crate::text::js_trim;

/// Where Claude keeps a project's data: every character outside
/// `[a-zA-Z0-9_-]` of the folder's real path becomes a dash.
pub fn encode_cwd(real_path: &str) -> String {
    real_path.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).collect()
}

/// A conversation as far as the transcript tells it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TranscriptView {
    pub rows: Vec<PtyConversationRow>,
    /// A turn is under way.
    pub running: bool,
    /// The latest dialog tool call with no result yet.
    pub pending: Option<PtyPending>,
}

/// The fields the branch walk needs: all an entry keeps once its step is known.
#[derive(Debug, Clone)]
struct Link {
    uuid: Option<String>,
    parent: Option<String>,
    /// A user or assistant entry: a possible tip of the branch.
    speaks: bool,
    sidechain: bool,
}

/// What one entry adds to the view; it depends only on the entry and its position.
#[derive(Debug, Clone, Default)]
struct Step {
    /// Claude closes every turn with this marker (it hangs off the branch
    /// tip, so it is never on the walked path itself): it counts anywhere.
    turn_end: bool,
    row: Option<PtyConversationRow>,
    running: Option<bool>,
    opens: Vec<PtyPending>,
    answers: Vec<String>,
    /// A new prompt or an interrupt: any open dialog is gone.
    clears: bool,
}

/// A transcript read as it grows.
#[derive(Debug, Clone, Default)]
pub struct TranscriptRows {
    sidechain: bool,
    links: Vec<Link>,
    steps: Vec<Step>,
}

impl TranscriptRows {
    /// `sidechain` reads a subagent's own transcript, whose entries are all sidechain.
    pub fn new(sidechain: bool) -> Self {
        Self { sidechain, ..Self::default() }
    }

    /// Takes whole lines. A line that is not JSON is skipped.
    pub fn add(&mut self, lines: &str) {
        for entry in parse_entries(lines) {
            self.steps.push(step_of(&entry, self.links.len()));
            self.links.push(link_of(&entry));
        }
    }

    /// The conversation so far. `tail` is an unfinished last line: it counts
    /// while it parses, and is kept only once a later [`add`](Self::add) has
    /// it whole.
    pub fn view(&self, tail: &str) -> TranscriptView {
        let last = if js_trim(tail).is_empty() { None } else { parse_entries(tail).into_iter().next() };
        let last = last.map(|entry| (link_of(&entry), step_of(&entry, self.links.len())));
        let links = self.links.iter().chain(last.as_ref().map(|(link, _)| link));
        let steps = self.steps.iter().chain(last.as_ref().map(|(_, step)| step));

        let on_path = active_branch(links.clone(), self.sidechain);
        let mut view = TranscriptView::default();
        // Open dialogs in the order they opened; the newest is the pending one.
        let mut waiting: Vec<&PtyPending> = Vec::new();
        for (link, step) in links.zip(steps) {
            if step.turn_end {
                view.running = false;
                continue;
            }
            if !link.uuid.as_ref().is_some_and(|uuid| on_path.contains(uuid.as_str())) {
                continue;
            }
            if step.clears {
                waiting.clear();
            }
            for open in &step.opens {
                // Opening an id again keeps its place in the order.
                match waiting.iter_mut().find(|w| w.tool_use_id == open.tool_use_id) {
                    Some(slot) => *slot = open,
                    None => waiting.push(open),
                }
            }
            waiting.retain(|w| !step.answers.contains(&w.tool_use_id));
            if let Some(running) = step.running {
                view.running = running;
            }
            view.rows.extend(step.row.clone());
        }
        view.pending = waiting.last().map(|p| (*p).clone());
        view
    }
}

/// A whole transcript at once.
pub fn transcript_view(jsonl: &str, sidechain: bool) -> TranscriptView {
    let mut rows = TranscriptRows::new(sidechain);
    rows.add(jsonl);
    rows.view("")
}

/// Every line that parses, in file order.
fn parse_entries(jsonl: &str) -> Vec<Value> {
    jsonl
        .split('\n')
        .filter(|line| !js_trim(line).is_empty())
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn link_of(entry: &Value) -> Link {
    let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_owned);
    Link {
        uuid: text("uuid"),
        parent: text("parentUuid"),
        speaks: matches!(entry.get("type").and_then(Value::as_str), Some("user" | "assistant")),
        sidechain: entry.get("isSidechain") == Some(&Value::Bool(true)),
    }
}

/// The ids on the active branch: from the newest entry that speaks, back
/// through its parents.
fn active_branch<'a>(links: impl Iterator<Item = &'a Link>, sidechain: bool) -> HashSet<&'a str> {
    let mut by_uuid: HashMap<&str, &Link> = HashMap::new();
    let mut tip = None;
    for link in links {
        let Some(uuid) = link.uuid.as_deref() else { continue };
        by_uuid.insert(uuid, link);
        if link.speaks && link.sidechain == sidechain {
            tip = Some(link);
        }
    }
    let mut on_path = HashSet::new();
    let mut cur = tip;
    while let Some(link) = cur {
        let Some(uuid) = link.uuid.as_deref() else { break };
        if !on_path.insert(uuid) {
            break;
        }
        cur = link.parent.as_deref().and_then(|parent| by_uuid.get(parent).copied());
    }
    on_path
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null | Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String(value)` for the values an id can be.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
        Some(other) => other.to_string(),
    }
}

/// A field as the mapper reads it: the value, or `fallback` when it is
/// missing or null.
fn or(value: Option<&Value>, fallback: Value) -> Value {
    match value {
        None | Some(Value::Null) => fallback,
        Some(value) => value.clone(),
    }
}

fn dialog_name(name: &Value) -> Option<PtyPendingName> {
    match name.as_str()? {
        "AskUserQuestion" => Some(PtyPendingName::AskUserQuestion),
        "ExitPlanMode" => Some(PtyPendingName::ExitPlanMode),
        _ => None,
    }
}

fn row(id: usize, ts: f64, kind: &str, payload: Value) -> PtyConversationRow {
    PtyConversationRow { id: id as i64, ts: ts.into(), r#type: kind.to_owned(), payload: Some(payload) }
}

fn step_of(entry: &Value, index: usize) -> Step {
    let field = |key: &str| entry.get(key);
    let is = |key: &str, text: &str| field(key).and_then(Value::as_str) == Some(text);
    let is_true = |key: &str| field(key) == Some(&Value::Bool(true));

    if is("type", "system") && is("subtype", "turn_duration") && !is_true("isSidechain") {
        return Step { turn_end: true, ..Step::default() };
    }
    if is_true("isMeta") || is_true("isCompactSummary") || !truthy(field("message")) {
        return Step::default();
    }
    let id = index + 1;
    let ts = field("timestamp").and_then(Value::as_str).and_then(parse_timestamp).unwrap_or(0.0);
    let message = field("message");
    let content = message.and_then(|m| m.get("content"));

    if is("type", "assistant")
        && let Some(blocks) = content.and_then(Value::as_array)
    {
        let blocks = durable_blocks(&js_string(field("uuid")), blocks);
        let opens = blocks
            .iter()
            .filter(|b| b["type"] == "tool_call")
            .filter_map(|b| {
                Some(PtyPending {
                    tool_use_id: b["callId"].as_str().unwrap_or_default().to_owned(),
                    name: dialog_name(&b["name"])?,
                    input: b["input"].as_object().map(|o| o.clone().into_iter().collect()).unwrap_or_default(),
                })
            })
            .collect();
        // Blocks are written as each completes, before the message's stop
        // reason is known: only a final reason other than tool_use ends the turn.
        let stop = message.and_then(|m| m.get("stop_reason"));
        let open_ended = matches!(stop, None | Some(Value::Null)) || stop.and_then(Value::as_str) == Some("tool_use");
        return Step {
            running: Some(!is_true("isApiErrorMessage") && open_ended),
            opens,
            row: (!blocks.is_empty()).then(|| {
                row(id, ts, "agent_event", json!({ "type": "message", "role": "assistant", "blocks": blocks }))
            }),
            ..Step::default()
        };
    }
    if !is("type", "user") {
        return Step::default();
    }

    let results: Vec<&Value> = content
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
        .collect();
    if !results.is_empty() {
        let patch = field("toolUseResult").and_then(|r| r.get("structuredPatch")).and_then(parse_structured_patch);
        let call_id = |r: &Value| or(r.get("tool_use_id"), json!(""));
        let blocks: Vec<Value> = results
            .iter()
            .map(|r| {
                let mut block = Map::new();
                block.insert("type".into(), json!("tool_result"));
                block.insert("callId".into(), call_id(r));
                block.insert("isError".into(), json!(r.get("is_error") == Some(&Value::Bool(true))));
                block.insert("content".into(), json!(block_text(r.get("content"))));
                if let Some(patch) = &patch {
                    block.insert("patch".into(), json!(patch));
                }
                Value::Object(block)
            })
            .collect();
        return Step {
            running: Some(true),
            answers: results.iter().map(|r| call_id(r).as_str().unwrap_or_default().to_owned()).collect(),
            row: Some(row(id, ts, "agent_event", json!({ "type": "message", "role": "tool", "blocks": blocks }))),
            ..Step::default()
        };
    }

    match prompt_of(content) {
        None => Step::default(),
        Some(Prompt::Interrupt) => Step {
            clears: true,
            running: Some(false),
            row: Some(row(id, ts, "agent_event", json!({ "type": "turn", "phase": "aborted" }))),
            ..Step::default()
        },
        Some(Prompt::Text(text)) => Step {
            clears: true,
            running: Some(true),
            row: Some(row(id, ts, "user_message", json!({ "text": text }))),
            ..Step::default()
        },
    }
}

/// An assistant message's blocks as the agent lane records them
/// (`durableBlocks` in the SDK event mapper): text, non-empty thinking, tool
/// calls; a block's id is its message's id and its position.
fn durable_blocks(message_id: &str, content: &[Value]) -> Vec<Value> {
    let mut blocks = Vec::new();
    for (i, block) in content.iter().enumerate() {
        let block_id = format!("{message_id}:{i}");
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                blocks.push(json!({ "type": "text", "text": or(block.get("text"), json!("")), "blockId": block_id }))
            }
            Some("thinking") => {
                let thinking = or(block.get("thinking"), json!(""));
                if thinking.as_str().is_some_and(|t| !js_trim(t).is_empty()) {
                    blocks.push(json!({ "type": "reasoning", "text": thinking, "blockId": block_id }));
                }
            }
            Some("tool_use") => {
                let name = or(block.get("name"), json!(""));
                let mut call = Map::new();
                call.insert("type".into(), json!("tool_call"));
                call.insert("callId".into(), or(block.get("id"), json!("")));
                call.insert("name".into(), name.clone());
                call.insert("input".into(), or(block.get("input"), json!({})));
                // The subagent tool, marked so every lane agrees on it.
                if name == "Agent" {
                    call.insert("spawnsSubagent".into(), json!(true));
                }
                blocks.push(Value::Object(call));
            }
            _ => {}
        }
    }
    blocks
}

/// A tool result's text: the string itself, or its blocks' text joined.
fn block_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item.get("text") {
                None | Some(Value::Null) => String::new(),
                Some(Value::String(s)) => s.clone(),
                Some(other) => other.to_string(),
            })
            .collect(),
        _ => String::new(),
    }
}

enum Prompt {
    Text(String),
    Interrupt,
}

static PASTE_TAG: LazyLock<Regex> = LazyLock::new(|| pattern(r#"\n?</?pasted_content id="[^"]*">\n?"#));
static COMMAND_NAME: LazyLock<Regex> = LazyLock::new(|| pattern(r"<command-name>([^<]*)</command-name>"));
static COMMAND_ARGS: LazyLock<Regex> = LazyLock::new(|| pattern(r"<command-args>([^<]*)</command-args>"));
static CHATTER: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"^<(local-command-|bash-stdout|bash-stderr|task-notification)"));

fn pattern(source: &str) -> Regex {
    match Regex::new(source) {
        Ok(regex) => regex,
        Err(e) => panic!("the pattern {source} is fixed and valid: {e}"),
    }
}

fn first_group<'t>(regex: &Regex, text: &'t str) -> Option<&'t str> {
    regex.find(text).and_then(|m| m.group(1)).map(|range| &text[range])
}

/// A typed prompt, an interrupt marker, or harness chatter that is not conversation.
fn classify_prompt(raw: &str) -> Option<Prompt> {
    // A pasted prompt (how a remote message is delivered) is recorded wrapped
    // in <pasted_content id="…"> tags: show just what was pasted.
    let mut unwrapped = String::with_capacity(raw.len());
    let mut at = 0;
    for tag in PASTE_TAG.find_iter(raw) {
        unwrapped.push_str(&raw[at..tag.start()]);
        unwrapped.push('\n');
        at = tag.end();
    }
    unwrapped.push_str(&raw[at..]);
    let text = js_trim(&unwrapped);
    if text.is_empty() {
        return None;
    }
    if text.starts_with("[Request interrupted") {
        return Some(Prompt::Interrupt);
    }
    // A slash command is echoed as tags: show what the user typed.
    if let Some(name) = first_group(&COMMAND_NAME, text) {
        let args = first_group(&COMMAND_ARGS, text).map(js_trim).filter(|a| !a.is_empty());
        let typed: Vec<&str> = [Some(js_trim(name)).filter(|n| !n.is_empty()), args].into_iter().flatten().collect();
        return Some(Prompt::Text(typed.join(" ")));
    }
    if CHATTER.find(text).is_some() {
        return None;
    }
    Some(Prompt::Text(text.to_owned()))
}

fn prompt_of(content: Option<&Value>) -> Option<Prompt> {
    match content? {
        Value::String(text) => classify_prompt(text),
        Value::Array(blocks) => {
            let parts: Vec<String> = blocks
                .iter()
                .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                    Some("text") => b.get("text").and_then(Value::as_str).map(str::to_owned),
                    Some("image") => Some("[image]".to_owned()),
                    _ => None,
                })
                .filter(|part| !part.is_empty())
                .collect();
            classify_prompt(&parts.join("\n"))
        }
        _ => None,
    }
}

/// Epoch milliseconds of an ISO 8601 instant, as Claude writes them
/// (`2026-09-27T10:00:00.000Z`); `None` for anything else.
fn parse_timestamp(text: &str) -> Option<f64> {
    let (date, time) = text.split_once('T')?;
    let mut ymd = date.split('-').map(|p| p.parse::<i64>().ok());
    let (year, month, day) = (ymd.next()??, ymd.next()??, ymd.next()??);
    if ymd.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (clock, offset_minutes) = if let Some(clock) = time.strip_suffix('Z') {
        (clock, 0)
    } else {
        let at = time.rfind(['+', '-'])?;
        let (clock, zone) = time.split_at(at);
        let (hours, minutes) = zone[1..].split_once(':')?;
        let minutes = hours.parse::<i64>().ok()? * 60 + minutes.parse::<i64>().ok()?;
        (clock, if zone.starts_with('-') { -minutes } else { minutes })
    };
    let (hms, fraction) = clock.split_once('.').unwrap_or((clock, "0"));
    let mut parts = hms.split(':').map(|p| p.parse::<i64>().ok());
    let (hour, minute, second) = (parts.next()??, parts.next()??, parts.next().unwrap_or(Some(0))?);
    if parts.next().is_some()
        || hour > 24
        || minute > 59
        || second > 59
        || !fraction.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let millis: f64 = format!("0.{fraction}").parse::<f64>().ok()? * 1000.0;

    // Days since 1970-01-01 in the proleptic Gregorian calendar.
    let (y, m) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * m + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
    Some((seconds * 1000) as f64 + millis.trunc())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_folder_is_named_by_its_path_with_dashes() {
        assert_eq!(encode_cwd("/Users/me/My Project.v2"), "-Users-me-My-Project-v2");
        assert_eq!(encode_cwd("/a/b_c-d"), "-a-b_c-d");
    }

    #[test]
    fn timestamps_are_read_as_javascript_reads_them() {
        assert_eq!(parse_timestamp("2026-09-27T10:00:00.000Z"), Some(1_790_503_200_000.0));
        assert_eq!(parse_timestamp("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(parse_timestamp("2024-02-29T23:59:59.999Z"), Some(1_709_251_199_999.0));
        assert_eq!(parse_timestamp("2026-09-27T12:00:00.5+02:00"), Some(1_790_503_200_500.0));
        assert_eq!(parse_timestamp("yesterday"), None);
        assert_eq!(parse_timestamp("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn rows_keep_their_ids_while_the_file_grows() {
        let first = r#"{"type":"user","uuid":"a","parentUuid":null,"message":{"role":"user","content":"hi"}}"#;
        let second = r#"{"type":"assistant","uuid":"b","parentUuid":"a","message":{"role":"assistant","content":[{"type":"text","text":"yo"}],"stop_reason":"end_turn"}}"#;
        let mut rows = TranscriptRows::new(false);
        rows.add(&format!("{first}\n"));
        assert_eq!(rows.view("").rows.iter().map(|r| r.id).collect::<Vec<_>>(), [1]);
        assert!(rows.view("").running);
        // The half-written answer shows as soon as it parses, and is not kept.
        assert_eq!(rows.view(second).rows.len(), 2);
        assert_eq!(rows.view(&second[..30]).rows.len(), 1);
        rows.add(&format!("{second}\n"));
        let view = rows.view("");
        assert_eq!(view.rows.iter().map(|r| r.id).collect::<Vec<_>>(), [1, 2]);
        assert!(!view.running);
    }
}
