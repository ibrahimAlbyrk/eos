//! What a pane reports through its own output: its title (OSC 0 / 2) and,
//! for a Claude pane, the session id and an open dialog (OSC 7777, written
//! by the launch hooks — see `launch`).

use std::sync::LazyLock;

use base64::Engine as _;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use eos_contracts::{PtyPending, PtyPendingName};
use regress::Regex;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OscEvent {
    /// `None`: the title was cleared.
    Title(Option<String>),
    ClaudeSession(String),
    DialogTool(PtyPending),
}

const SESSION_PREFIX: &str = "eos-claude-session=";
const TOOL_PREFIX: &str = "eos-claude-tool=";
/// Longest report worth waiting for across pieces of output: a dialog tool
/// report carries a whole plan.
const MAX_OSC: usize = 1024 * 1024;

fn fixed(source: &str, flags: &str) -> Regex {
    match Regex::with_flags(source, flags) {
        Ok(regex) => regex,
        Err(e) => panic!("the pattern {source} is fixed and valid: {e}"),
    }
}

/// Leading status glyphs (Claude's spinner) are not part of a title.
static GLYPHS: LazyLock<Regex> = LazyLock::new(|| fixed(r"^[^\p{L}\p{N}]+", "u"));
static UUID: LazyLock<Regex> =
    LazyLock::new(|| fixed(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "i"));

/// Reads reports out of a pane's output. A sequence cut between two pieces
/// is carried to the next.
#[derive(Debug, Default)]
pub(crate) struct OscScanner {
    carry: String,
}

impl OscScanner {
    pub(crate) fn scan(&mut self, data: &str) -> Vec<OscEvent> {
        let joined;
        let s = if self.carry.is_empty() {
            data
        } else {
            joined = std::mem::take(&mut self.carry) + data;
            &joined
        };
        let mut out = Vec::new();
        let mut next = s.find("\x1b]");
        while let Some(i) = next {
            let rest = &s[i + 2..];
            let end = match (rest.find('\x07'), rest.find("\x1b\\")) {
                (Some(bel), Some(st)) => bel.min(st),
                (Some(end), None) | (None, Some(end)) => end,
                (None, None) => {
                    if s.len() - i <= MAX_OSC {
                        self.carry = s[i..].to_owned();
                    }
                    return out;
                }
            };
            out.extend(parse(&rest[..end]));
            let after = i + 2 + end + 1;
            next = s.get(after..).and_then(|tail| tail.find("\x1b]")).map(|at| after + at);
        }
        if s.ends_with('\x1b') {
            self.carry = "\x1b".to_owned();
        }
        out
    }
}

fn parse(body: &str) -> Option<OscEvent> {
    let (code, arg) = body.split_once(';')?;
    if code == "0" || code == "2" {
        let from = GLYPHS.find(arg).map_or(0, |m| m.end());
        let title = eos_domain::text::js_trim(&arg[from..]);
        return Some(OscEvent::Title((!title.is_empty()).then(|| title.to_owned())));
    }
    if code != "7777" {
        return None;
    }
    if let Some(id) = arg.strip_prefix(SESSION_PREFIX) {
        return UUID.find(id).map(|_| OscEvent::ClaudeSession(id.to_owned()));
    }
    arg.strip_prefix(TOOL_PREFIX).and_then(tool_report).map(OscEvent::DialogTool)
}

/// The hook's input (tool name, input, id), which rides along as base64.
fn tool_report(encoded: &str) -> Option<PtyPending> {
    // As lenient as Node's decoder: either alphabet, padding or none.
    const LENIENT: GeneralPurpose = GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let clean: String = encoded
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            '-' => Some('+'),
            '_' => Some('/'),
            c if c.is_ascii_alphanumeric() || c == '+' || c == '/' => Some(c),
            _ => None,
        })
        .collect();
    let bytes = LENIENT.decode(clean).ok()?;
    let hook: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    let name = match hook.get("tool_name")?.as_str()? {
        "AskUserQuestion" => PtyPendingName::AskUserQuestion,
        "ExitPlanMode" => PtyPendingName::ExitPlanMode,
        _ => return None,
    };
    let tool_use_id = hook.get("tool_use_id")?.as_str()?.to_owned();
    let input = hook.get("tool_input")?.as_object()?.clone().into_iter().collect();
    Some(PtyPending { tool_use_id, name, input })
}
