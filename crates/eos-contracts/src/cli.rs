//! The terminal's `eos` command and the app's gateway on `<shell data>/cli.sock` (07 §4.4): one
//! [`CliRequest`] per connection, as a line of JSON, answered by [`CliFrame`] lines until a
//! `done` frame names the exit code. The gateway turns each request into the dashboard's own
//! core calls, so nothing here reaches the core by itself. Added; no older app speaks it.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::validate::{Issues, Validate};

/// The largest request the gateway reads.
pub const CLI_REQUEST_MAX_BYTES: usize = 2 * 1024 * 1024;
/// The most text piped into the command that becomes an item.
pub const CLI_STDIN_MAX_BYTES: usize = 1024 * 1024;
/// The most items or files one `run` names.
pub const CLI_ITEMS_MAX: usize = 20;
/// The longest value a note, an option or an item may have.
const VALUE_MAX_BYTES: usize = 4 * 1024;

/// Exit codes the command ends with.
pub mod exit {
    pub const OK: i32 = 0;
    /// The run ended failed, cancelled or skipped.
    pub const RUN_FAILED: i32 = 1;
    /// Refused, or bad usage.
    pub const REFUSED: i32 = 2;
    /// Eos cannot be reached.
    pub const UNREACHABLE: i32 = 3;
    /// The user detached from a `--wait` (Ctrl-C); the run goes on.
    pub const DETACHED: i32 = 130;
}

/// What the command asks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "cmd", rename_all = "camelCase")]
pub enum CliRequest {
    /// Whether the app is up: answered `hello` and `done`.
    Hello,
    /// `eos routines`.
    Routines {
        #[serde(default)]
        json: bool,
    },
    /// `eos run <routine> [item…]`.
    Run(CliRun),
    /// `eos once "<what to do>"`.
    Once(CliOnce),
    /// `eos halt`: every routine stops sending and starting.
    Halt,
    /// `eos resume`.
    Resume,
    /// `eos memory hook --event <name>`: a Claude Code hook's input, answered within 300 ms.
    MemoryHook { event: String, input: Value },
}

/// `eos run`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CliRun {
    /// The routine's slug or id.
    pub routine: String,
    /// Each item makes a run of its own.
    #[serde(default)]
    pub items: Vec<String>,
    /// Absolute paths of files, each an item.
    #[serde(default)]
    pub files: Vec<String>,
    /// Text piped into the command: one more item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// `--option name=value`, by name.
    #[serde(default)]
    pub options: BTreeMap<String, String>,
    #[serde(default)]
    pub show_only: bool,
    /// `--at <when>`, as the user wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(default)]
    pub wait: bool,
    /// The user agreed to start several runs (`--yes`, or yes at the prompt).
    #[serde(default)]
    pub yes: bool,
    #[serde(default)]
    pub json: bool,
}

/// `eos once`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CliOnce {
    pub what: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
    #[serde(default)]
    pub show_only: bool,
    #[serde(default)]
    pub wait: bool,
    #[serde(default)]
    pub json: bool,
}

/// One line the gateway answers with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum CliFrame {
    /// The app's version, and whether its core is ready.
    Hello { version: String, ready: bool },
    /// A line for standard output: a result, a list, a run's link.
    Out { text: String },
    /// A line for standard error: progress, a run waiting for the user, why it was refused.
    Err { text: String },
    /// `--json`: the answer as data, on standard output.
    Json { value: Value },
    /// Several runs would start: the command asks the user (or needs `--yes` off a terminal)
    /// and sends the request again with `yes`.
    Confirm { text: String },
    /// The last frame: the code the command exits with.
    Done { exit: i32 },
}

fn slug_or_id(cx: &mut Issues, v: &str) {
    cx.str_min(v, 1);
    cx.str_max(v, 64);
    if !v.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        cx.push("a routine's name is lowercase letters, digits and dashes");
    }
}

fn bytes_max(cx: &mut Issues, v: &str, max: usize) {
    if v.len() > max {
        cx.push(format!("at most {max} bytes"));
    }
}

fn files(cx: &mut Issues, files: &[String]) {
    cx.arr_max(files.len(), CLI_ITEMS_MAX);
    for (n, file) in files.iter().enumerate() {
        cx.idx(n, |cx| {
            if !file.starts_with('/') {
                cx.push("an absolute path");
            }
            bytes_max(cx, file, VALUE_MAX_BYTES);
        });
    }
}

impl Validate for CliRun {
    fn validate(&self, cx: &mut Issues) {
        cx.at("routine", |cx| slug_or_id(cx, &self.routine));
        cx.at("items", |cx| {
            cx.arr_max(self.items.len() + self.files.len(), CLI_ITEMS_MAX);
            for (n, item) in self.items.iter().enumerate() {
                cx.idx(n, |cx| {
                    cx.str_min(item, 1);
                    bytes_max(cx, item, VALUE_MAX_BYTES);
                });
            }
        });
        cx.at("files", |cx| files(cx, &self.files));
        cx.at("stdin", |cx| self.stdin.iter().for_each(|text| bytes_max(cx, text, CLI_STDIN_MAX_BYTES)));
        cx.at("note", |cx| self.note.iter().for_each(|note| bytes_max(cx, note, VALUE_MAX_BYTES)));
        cx.at("options", |cx| {
            for (name, value) in &self.options {
                cx.at(name, |cx| {
                    slug_or_id(cx, name);
                    bytes_max(cx, value, VALUE_MAX_BYTES);
                });
            }
        });
        cx.at("at", |cx| self.at.iter().for_each(|at| bytes_max(cx, at, 200)));
    }
}

impl Validate for CliOnce {
    fn validate(&self, cx: &mut Issues) {
        cx.at("what", |cx| {
            cx.str_min(self.what.trim(), 1);
            bytes_max(cx, &self.what, VALUE_MAX_BYTES);
        });
        cx.at("files", |cx| files(cx, &self.files));
        cx.at("stdin", |cx| self.stdin.iter().for_each(|text| bytes_max(cx, text, CLI_STDIN_MAX_BYTES)));
    }
}

impl Validate for CliRequest {
    fn validate(&self, cx: &mut Issues) {
        match self {
            CliRequest::Run(run) => run.validate(cx),
            CliRequest::Once(once) => once.validate(cx),
            CliRequest::MemoryHook { event, .. } => cx.at("event", |cx| {
                cx.str_min(event, 1);
                cx.str_max(event, 64);
            }),
            CliRequest::Hello | CliRequest::Routines { .. } | CliRequest::Halt | CliRequest::Resume => {}
        }
    }
}

impl Validate for CliFrame {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn issues(request: &CliRequest) -> Vec<String> {
        let mut cx = Issues::default();
        request.validate(&mut cx);
        cx.into_vec().into_iter().map(|issue| issue.message).collect()
    }

    fn run(value: Value) -> CliRequest {
        serde_json::from_value(value).expect("a request")
    }

    #[test]
    fn a_request_reads_as_the_command_wrote_it_and_unknown_fields_are_ignored() {
        let asked = run(json!({"cmd": "run", "routine": "pr-review", "items": ["482"], "wait": true, "later": 1}));
        let CliRequest::Run(run_of) = &asked else { panic!("a run: {asked:?}") };
        assert_eq!(
            (run_of.routine.as_str(), run_of.items.as_slice(), run_of.wait),
            ("pr-review", &["482".to_owned()][..], true)
        );
        assert!(issues(&asked).is_empty());
        assert_eq!(serde_json::from_value::<CliRequest>(json!({"cmd": "halt"})).expect("halt"), CliRequest::Halt);
        let frame = serde_json::to_value(CliFrame::Done { exit: exit::DETACHED }).expect("json");
        assert_eq!(frame, json!({"t": "done", "exit": 130}));
    }

    #[test]
    fn names_paths_counts_and_sizes_are_bounded() {
        let bad = run(json!({"cmd": "run", "routine": "PR Review", "files": ["notes.txt"],
                             "items": vec!["x"; 20], "options": {"Depth": "1"}}));
        let found = issues(&bad);
        assert_eq!(found.len(), 4, "{found:?}");
        let big = "x".repeat(CLI_STDIN_MAX_BYTES + 1);
        assert_eq!(issues(&run(json!({"cmd": "run", "routine": "pr-review", "stdin": big}))).len(), 1);
        let piped = "x".repeat(CLI_STDIN_MAX_BYTES);
        assert!(issues(&run(json!({"cmd": "once", "what": "Tidy my downloads", "stdin": piped}))).is_empty());
        assert_eq!(issues(&run(json!({"cmd": "once", "what": "  "}))).len(), 1);
    }
}
