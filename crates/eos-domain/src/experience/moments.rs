//! Moments: the surprises a conversation's rows reveal, which memory learns
//! from. A moment holds the rows it spans and its cues, never text. The
//! rules read a worker's `events` rows in order, plus the user's denials and
//! reactions from their own tables; every phrase table is in English and
//! Turkish.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::cues::{self, Cue};
use super::note::{HookKind, Trust};
use crate::EventRecord;

/// A correction or rule cue counts only this early in a message.
const CUE_CHARS: usize = 120;
/// A stop this soon after the agent's output still stops that output.
const STOP_AFTER_OUTPUT_MS: i64 = 30_000;
/// A message this soon after a stop explains the stop.
const STOP_JOIN_MS: i64 = 120_000;
/// Two requests at most this many messages apart, this alike, are a repeat.
const REPEAT_WITHIN: usize = 3;
const REPEAT_SIMILARITY: f64 = 0.5;
/// Failures of one command before its success make a hard-won skill.
const HARD_WON_FAILURES: usize = 2;

/// What the user or the work showed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Signal {
    SaysWrong,
    StatesRule,
    Stops,
    Undoes,
    Denies,
    ThumbsDown,
    Edits,
    Repeats,
    CommandFails,
    TestFails,
    CheckerDisagrees,
    HardWon,
    /// Quiet acceptance: credit for what was recalled, never a note.
    Accepted,
}

impl Signal {
    pub fn as_str(self) -> &'static str {
        match self {
            Signal::SaysWrong => "says_wrong",
            Signal::StatesRule => "states_rule",
            Signal::Stops => "stops",
            Signal::Undoes => "undoes",
            Signal::Denies => "denies",
            Signal::ThumbsDown => "thumbs_down",
            Signal::Edits => "edits",
            Signal::Repeats => "repeats",
            Signal::CommandFails => "command_fails",
            Signal::TestFails => "test_fails",
            Signal::CheckerDisagrees => "checker_disagrees",
            Signal::HardWon => "hard_won",
            Signal::Accepted => "accepted",
        }
    }

    /// Where the knowledge comes from.
    pub fn trust(self) -> Trust {
        match self {
            Signal::SaysWrong | Signal::StatesRule => Trust::Said,
            Signal::CommandFails | Signal::TestFails | Signal::CheckerDisagrees | Signal::HardWon => Trust::Outcome,
            _ => Trust::Did,
        }
    }
}

/// A moment found, before it is stored.
#[derive(Debug, Clone, PartialEq)]
pub struct MomentDraft {
    pub signal: Signal,
    pub trust: Trust,
    /// The rows it spans (event ids, or the other table's row for a denial or reaction).
    pub row_from: i64,
    pub row_to: i64,
    pub cues: Vec<Cue>,
    /// Seen in a subagent's work: it feeds moments, never reminders.
    pub subagent: bool,
}

/// What a user's message says, by its words alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageClass {
    /// A rule for every time ("always", "from now on").
    Rule,
    /// The agent got it wrong.
    Correction,
    /// Neither cue, but words that may correct ("actually", "instead"): a small model decides.
    Unclear,
    Neutral,
}

const RULE_CUES: &[&str] = &[
    "always",
    "never",
    "from now on",
    "every time",
    "don't ever",
    "do not ever",
    "in this repo we",
    "her zaman",
    "asla",
    "bundan sonra",
    "hiçbir zaman",
    "her seferinde",
];
const ONE_OFF: &[&str] =
    &["this time", "just this once", "only this once", "for now", "bu sefer", "bu seferlik", "şimdilik"];
const CORRECTION_CUES: &[&str] =
    &["wrong", "not like that", "that's not", "that is not", "you broke", "yanlış", "öyle değil", "bozdun"];
/// Corrections only as the message's first word.
const CORRECTION_OPENERS: &[&str] = &["no", "nope", "hayır", "hayir"];
const UNCLEAR_CUES: &[&str] = &["actually", "instead", "should", "rather", "aslında", "yerine", "olmalı"];

/// `phrase` stands as whole words in `text` (both lowercased).
fn has_phrase(text: &str, phrase: &str) -> bool {
    text.match_indices(phrase).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + phrase.len()..].chars().next();
        before.is_none_or(|c| !c.is_alphanumeric()) && after.is_none_or(|c| !c.is_alphanumeric())
    })
}

/// The class of a user's message: a rule beats a correction.
pub fn classify_user_message(text: &str) -> MessageClass {
    let head: String = text.trim().chars().take(CUE_CHARS).collect::<String>().to_lowercase();
    let any = |table: &[&str]| table.iter().any(|p| has_phrase(&head, p));
    if any(RULE_CUES) && !any(ONE_OFF) {
        return MessageClass::Rule;
    }
    let first = head.split(|c: char| !c.is_alphanumeric()).next().unwrap_or("");
    if CORRECTION_OPENERS.contains(&first) || any(CORRECTION_CUES) {
        return MessageClass::Correction;
    }
    if any(UNCLEAR_CUES) { MessageClass::Unclear } else { MessageClass::Neutral }
}

/// Programs whose failure answers a question rather than fails.
const PROBES: &[&str] = &["which", "test", "[", "[[", "ls", "stat", "grep", "rg", "command", "type"];
const TEST_RUNNERS: &[&str] = &[
    "cargo test",
    "npm test",
    "pnpm test",
    "yarn test",
    "pytest",
    "go test",
    "vitest",
    "jest",
    "xcodebuild test",
    "cargo nextest",
];

/// A failed command that only probed.
pub fn is_probe(command: &str) -> bool {
    let step = cues::last_step(command);
    let head = step.split_whitespace().next().unwrap_or("");
    PROBES.contains(&head.rsplit('/').next().unwrap_or(head))
}

pub fn is_test_run(command: &str) -> bool {
    let lower = command.to_lowercase();
    TEST_RUNNERS.iter().any(|r| has_phrase(&lower, r))
}

/// Words of a message, for the repeat test.
fn words(text: &str) -> HashSet<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 1).map(str::to_owned).collect()
}

/// Jaccard similarity of two texts' words.
pub fn word_similarity(a: &str, b: &str) -> f64 {
    let (a, b) = (words(a), words(b));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    a.intersection(&b).count() as f64 / a.union(&b).count() as f64
}

/// A user's deny of a tool call (`pending_permissions` resolved `deny` by
/// the user; expiry denials are not the user's and never come here).
#[derive(Debug, Clone, PartialEq)]
pub struct Denial {
    pub row: i64,
    pub tool: String,
}

/// A reaction the user left on an agent message.
#[derive(Debug, Clone, PartialEq)]
pub struct Reaction {
    pub row: i64,
    pub thumbs_up: bool,
}

/// A tool call seen in the rows.
struct Call {
    tool: String,
    input: Value,
    subagent: bool,
}

/// Everything one scan learns as it walks the rows.
#[derive(Default)]
struct Walk {
    out: Vec<MomentDraft>,
    calls: HashMap<String, Call>,
    finished: HashSet<String>,
    running: HashSet<String>,
    last_output_at: Option<i64>,
    /// The user's recent requests: row and text.
    requests: Vec<(i64, String)>,
    /// The agent spoke since the user's last message.
    agent_turn: bool,
    /// Failures per command key in this turn, and their first row.
    failures: HashMap<String, (usize, i64)>,
    /// The tool the policy last denied, so its failed result is no command failure.
    denied_tool: Option<String>,
    /// A stop waiting for its explanation, and when it came.
    open_stop: Option<(usize, i64)>,
}

impl Walk {
    fn push(&mut self, signal: Signal, row_from: i64, row_to: i64, cues: Vec<Cue>, subagent: bool) -> usize {
        self.out.push(MomentDraft { signal, trust: signal.trust(), row_from, row_to, cues, subagent });
        self.out.len() - 1
    }

    fn user_message(&mut self, row: &EventRecord, payload: &Value) {
        let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
        let message_cues = cues::from_message(text, None).cues;
        if let Some((stop, at)) = self.open_stop.take() {
            if row.ts - at <= STOP_JOIN_MS {
                self.out[stop].row_to = row.id;
                self.out[stop].cues.extend(message_cues.iter().cloned());
            }
        }
        match classify_user_message(text) {
            MessageClass::Rule => {
                self.push(Signal::StatesRule, row.id, row.id, message_cues.clone(), false);
            }
            MessageClass::Correction if self.agent_turn => {
                self.push(Signal::SaysWrong, row.id, row.id, message_cues.clone(), false);
            }
            MessageClass::Neutral if self.agent_turn => {
                self.push(Signal::Accepted, row.id, row.id, vec![], false);
            }
            _ => {}
        }
        let recent = self.requests.iter().rev().take(REPEAT_WITHIN);
        if let Some((first, _)) =
            recent.into_iter().find(|(_, earlier)| word_similarity(earlier, text) >= REPEAT_SIMILARITY)
        {
            let first = *first;
            self.push(Signal::Repeats, first, row.id, message_cues, false);
        }
        self.requests.push((row.id, text.to_owned()));
        self.agent_turn = false;
        self.failures.clear();
    }

    fn tool_started(&mut self, call_id: &str, tool: &str, input: &Value, subagent: bool) {
        self.running.insert(call_id.to_owned());
        self.calls.entry(call_id.to_owned()).or_insert_with(|| Call {
            tool: tool.to_owned(),
            input: input.clone(),
            subagent,
        });
    }

    fn tool_finished(&mut self, row: &EventRecord, call_id: &str, is_error: bool) {
        self.running.remove(call_id);
        if !self.finished.insert(call_id.to_owned()) {
            return;
        }
        let Some(call) = self.calls.get(call_id) else { return };
        let denied = self.denied_tool.as_deref() == Some(call.tool.as_str());
        if denied {
            self.denied_tool = None;
        }
        if !cues::is_shell(&call.tool) {
            return;
        }
        let Some(command) = cues::command_of(&call.input).map(str::to_owned) else { return };
        let key = cues::command_key(&command);
        let (call_cues, subagent) = (cues::from_tool(&call.tool, &call.input, None), call.subagent);
        if is_error {
            if denied || is_probe(&command) {
                return;
            }
            let signal = if is_test_run(&command) { Signal::TestFails } else { Signal::CommandFails };
            self.push(signal, row.id, row.id, call_cues, subagent);
            let entry = self.failures.entry(key).or_insert((0, row.id));
            entry.0 += 1;
        } else if let Some((count, first)) = self.failures.remove(&key) {
            if count >= HARD_WON_FAILURES {
                self.push(Signal::HardWon, first, row.id, call_cues, subagent);
            }
        }
    }

    fn agent_event(&mut self, row: &EventRecord, payload: &Value) {
        let subagent = payload.get("parentCallId").is_some_and(|p| !p.is_null());
        match payload.get("type").and_then(Value::as_str) {
            Some("activity") => {
                let call_id = payload.get("callId").and_then(Value::as_str).unwrap_or("");
                match payload.get("kind").and_then(Value::as_str) {
                    Some("tool_started") => {
                        let tool = payload.get("toolName").and_then(Value::as_str).unwrap_or("");
                        let input = payload.get("input").cloned().unwrap_or(Value::Null);
                        self.tool_started(call_id, tool, &input, subagent);
                    }
                    Some("tool_finished") => {
                        let is_error = payload.get("isError").and_then(Value::as_bool).unwrap_or(false);
                        self.tool_finished(row, call_id, is_error);
                    }
                    _ => {}
                }
            }
            Some("message") => {
                self.agent_turn = true;
                self.last_output_at = Some(row.ts);
                for block in payload.get("blocks").and_then(Value::as_array).into_iter().flatten() {
                    let call_id = block.get("callId").and_then(Value::as_str).unwrap_or("");
                    match block.get("type").and_then(Value::as_str) {
                        Some("tool_call") => {
                            let tool = block.get("name").and_then(Value::as_str).unwrap_or("");
                            let input = block.get("input").cloned().unwrap_or(Value::Null);
                            self.tool_started(call_id, tool, &input, subagent);
                        }
                        Some("tool_result") => {
                            let is_error = block.get("isError").and_then(Value::as_bool).unwrap_or(false);
                            self.tool_finished(row, call_id, is_error);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    fn state(&mut self, row: &EventRecord, payload: &Value) {
        if payload.get("reason").and_then(Value::as_str) != Some("interrupt") {
            return;
        }
        let tool_running = !self.running.is_empty();
        let soon = self.last_output_at.is_some_and(|at| row.ts - at <= STOP_AFTER_OUTPUT_MS);
        self.running.clear();
        if tool_running || soon {
            let at = self.push(Signal::Stops, row.id, row.id, vec![], false);
            self.open_stop = Some((at, row.ts));
        }
    }
}

/// The moments in `rows` (one worker's events, oldest first), the user's
/// `denials` and `reactions` on agent messages.
pub fn scan(rows: &[EventRecord], denials: &[Denial], reactions: &[Reaction]) -> Vec<MomentDraft> {
    let mut walk = Walk::default();
    for row in rows {
        let payload: Value = row.payload.as_deref().and_then(|p| serde_json::from_str(p).ok()).unwrap_or(Value::Null);
        match row.kind.as_str() {
            "user_message" => walk.user_message(row, &payload),
            "agent_event" => walk.agent_event(row, &payload),
            "state" => walk.state(row, &payload),
            "policy" if payload.get("decision").and_then(Value::as_str) == Some("deny") => {
                walk.denied_tool = payload.get("tool").and_then(Value::as_str).map(str::to_owned);
            }
            "conversation_rewound" | "message_recalled" | "try_discarded" => {
                walk.push(Signal::Undoes, row.id, row.id, vec![], false);
            }
            "try_kept" => {
                walk.push(Signal::Accepted, row.id, row.id, vec![], false);
            }
            _ => {}
        }
    }
    for denial in denials {
        let cue = Cue { kind: HookKind::Tool, key: denial.tool.clone() };
        walk.push(Signal::Denies, denial.row, denial.row, vec![cue], false);
    }
    for reaction in reactions {
        let signal = if reaction.thumbs_up { Signal::Accepted } else { Signal::ThumbsDown };
        walk.push(signal, reaction.row, reaction.row, vec![], false);
    }
    walk.out
}

#[cfg(test)]
mod tests;
