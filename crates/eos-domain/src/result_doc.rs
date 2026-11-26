//! A routine run's result (`eos_contracts::ResultDoc`): the parts each kind
//! has, when two versions of a result are the same, and how one became the
//! other. Sameness is what the Freedom streak counts: a result sent as it was
//! drafted, once normalised, went out unedited. Pure; a result is the user's
//! text, so nothing here logs.

use std::collections::{HashMap, HashSet};

use eos_contracts::{EditOp, Part, PartEdit, ResultDoc};
use serde_json::{Map, Value};

pub mod shape;

/// A pull request review: [`EVENT`], [`SUMMARY`] and a [`comment_key`] per
/// line comment, whose meta holds its `path`, `line` and `side`. Its
/// comments are a set: their order does not count.
pub const GITHUB_REVIEW: &str = "github.review";
/// A mail: [`SUBJECT`], a [`paragraph_key`] per paragraph, in order, and a
/// [`recipient_key`] per recipient, as a set.
pub const MAIL: &str = "mail";
/// An issue of a Page: one part per field of the Page's contract, keyed by
/// the field's path (`stories[3].title`), in order, an [`ISSUE_PART`] naming
/// the stored issue, and a [`recipient_key`] per recipient, as a set. It is
/// sent as the mail the issue draws, never as these parts' text.
pub const PAGE_ISSUE: &str = "page.issue";
/// The part of a [`PAGE_ISSUE`] whose text is the stored issue's id; its
/// `meta.surface` names the page, and `meta.pdf` asks for the issue's PDF
/// beside the mail. A field of the issue's data never becomes such a part.
pub const ISSUE_PART: &str = "@issue";
/// A text (a message, a push, a note): [`BODY`].
pub const TEXT: &str = "text";
/// A Slack message to a conversation, a person or the user: a
/// [`paragraph_key`] per paragraph, in order.
pub const SLACK_MESSAGE: &str = "slack.message";
/// A Slack reply in the thread of the run's message: as [`SLACK_MESSAGE`].
pub const SLACK_REPLY: &str = "slack.reply";

pub const EVENT: &str = "event";
pub const SUMMARY: &str = "summary";
pub const SUBJECT: &str = "subject";
pub const BODY: &str = "body";

const COMMENT: &str = "c:";
const PARAGRAPH: &str = "p:";
const RECIPIENT: &str = "to:";

/// A review's `n`th line comment: `c:<n>`.
pub fn comment_key(n: usize) -> String {
    format!("{COMMENT}{n}")
}

/// A mail's `n`th paragraph: `p:<n>`.
pub fn paragraph_key(n: usize) -> String {
    format!("{PARAGRAPH}{n}")
}

/// A mail's recipient, by its id in the routine's Goes to: `to:<id>`.
pub fn recipient_key(recipient_id: &str) -> String {
    format!("{RECIPIENT}{recipient_id}")
}

/// Whether a result of `kind` names the recipients it goes to by
/// [`recipient_key`] parts.
pub fn names_recipients(kind: &str) -> bool {
    kind == MAIL || kind == PAGE_ISSUE
}

/// A page issue as a result: each field of `data` a part keyed by its path,
/// in order, then the [`ISSUE_PART`] naming `issue` (surface id, issue id).
/// A top-level data key that reads as a key of Eos's own (`@…`, `to:…`) is
/// left out: the run writes the data, and must not name the issue that is
/// mailed or who it goes to.
pub fn page_issue_doc(issue: (&str, &str), data: &Value, pdf: bool, channel: &str, action: &str) -> ResultDoc {
    let (surface_id, issue_id) = issue;
    let mut parts = Vec::new();
    fields(String::new(), data, &mut parts);
    let mut meta = Map::new();
    meta.insert("surface".to_owned(), Value::String(surface_id.to_owned()));
    if pdf {
        meta.insert("pdf".to_owned(), Value::Bool(true));
    }
    parts.push(Part { key: ISSUE_PART.to_owned(), role: "issue".to_owned(), text: issue_id.to_owned(), meta });
    ResultDoc { kind: PAGE_ISSUE.to_owned(), channel: channel.to_owned(), action: action.to_owned(), parts }
}

/// The stored issue a [`PAGE_ISSUE`] sends, and whether it asks for a PDF.
pub fn issue_of(doc: &ResultDoc) -> Option<(&str, bool)> {
    let part = doc.parts.iter().rev().find(|part| part.key == ISSUE_PART && part.role == "issue")?;
    Some((part.text.as_str(), part.meta.get("pdf") == Some(&Value::Bool(true))))
}

/// The leaves of `value` under `path`, as parts.
fn fields(path: String, value: &Value, out: &mut Vec<Part>) {
    let text = match value {
        Value::Null => return,
        Value::Object(map) => {
            for (name, value) in map {
                if path.is_empty() && (name.starts_with('@') || name.starts_with(RECIPIENT)) {
                    continue;
                }
                let at = if path.is_empty() { name.clone() } else { format!("{path}.{name}") };
                fields(at, value, out);
            }
            return;
        }
        Value::Array(items) => {
            for (n, value) in items.iter().enumerate() {
                fields(format!("{path}[{n}]"), value, out);
            }
            return;
        }
        Value::String(text) => text.clone(),
        other => other.to_string(),
    };
    out.push(Part { key: path, role: "field".to_owned(), text, meta: Map::new() });
}

/// A capability action a run's agent called, as a result: one [`BODY`]
/// part whose text is the action's input as JSON in a fenced block, for the
/// user to read and edit before it goes. Its channel names the capability
/// ([`action_channel`]), its action the action.
pub const ACTION: &str = "action";
const ACTION_CHANNEL: &str = "action:";
const FENCE_OPEN: &str = "```json\n";
const FENCE_CLOSE: &str = "\n```";

/// The channel a run's call of an action of `capability` goes out through.
pub fn action_channel(capability: &str) -> String {
    format!("{ACTION_CHANNEL}{capability}")
}

/// The capability an [`action_channel`] names; none for any other channel.
pub fn action_capability(channel: &str) -> Option<&str> {
    channel.strip_prefix(ACTION_CHANNEL).filter(|capability| !capability.is_empty())
}

/// A call of `action` of `capability` with `input`, as a result.
pub fn action_doc(capability: &str, action: &str, input: &Value) -> ResultDoc {
    let json = serde_json::to_string_pretty(input).unwrap_or_else(|_| input.to_string());
    let body = Part {
        key: BODY.to_owned(),
        role: "input".to_owned(),
        text: format!("{FENCE_OPEN}{json}{FENCE_CLOSE}"),
        meta: Map::new(),
    };
    ResultDoc {
        kind: ACTION.to_owned(),
        channel: action_channel(capability),
        action: action.to_owned(),
        parts: vec![body],
    }
}

/// The input an [`action_doc`] calls its action with, as the user left it:
/// a JSON object, fenced or not; none when the text is no such object.
pub fn action_input(doc: &ResultDoc) -> Option<Value> {
    let text = doc.parts.iter().find(|part| part.key == BODY)?.text.trim();
    let text = text.strip_prefix(FENCE_OPEN.trim_end()).unwrap_or(text);
    let text = text.strip_suffix(FENCE_CLOSE.trim_start()).unwrap_or(text);
    let input: Value = serde_json::from_str(text.trim()).ok()?;
    input.is_object().then_some(input)
}

/// A text as results compare it: line ends as LF, no space or tab at the
/// end of a line, no white space at either end.
pub fn normalize(text: &str) -> String {
    let lines = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = lines.split('\n').map(|line| line.trim_end_matches([' ', '\t'])).collect();
    lines.join("\n").trim().to_owned()
}

/// Whether `after` is `before` unedited: the same kind, channel and action,
/// and no part that changed, came, went or moved.
pub fn equal(before: &ResultDoc, after: &ResultDoc) -> bool {
    before.kind == after.kind
        && before.channel == after.channel
        && before.action == after.action
        && diff(before, after).is_empty()
}

/// How `after` differs from `before`, part by part, matched by key: first
/// the parts that went, in their old order; then, in the new order, each
/// part that came, changed or moved. A part that changed and moved is
/// `changed`. Parts whose order does not count never move.
pub fn diff(before: &ResultDoc, after: &ResultDoc) -> Vec<PartEdit> {
    let old: HashMap<&str, &Part> = before.parts.iter().map(|part| (part.key.as_str(), part)).collect();
    let new: HashMap<&str, &Part> = after.parts.iter().map(|part| (part.key.as_str(), part)).collect();
    let stayed = kept_in_order(&ordered_keys(before, &before.kind, &new), &ordered_keys(after, &before.kind, &old));

    let edit = |part: &Part, op, before: Option<&Part>, after: Option<&Part>| PartEdit {
        key: part.key.clone(),
        op,
        before: before.cloned(),
        after: after.cloned(),
    };
    let mut edits: Vec<PartEdit> = before
        .parts
        .iter()
        .filter(|part| !new.contains_key(part.key.as_str()))
        .map(|part| edit(part, EditOp::Removed, Some(part), None))
        .collect();
    for part in &after.parts {
        match old.get(part.key.as_str()) {
            None => edits.push(edit(part, EditOp::Added, None, Some(part))),
            Some(was) if !same(was, part) => edits.push(edit(part, EditOp::Changed, Some(was), Some(part))),
            Some(was) if !unordered(&before.kind, &part.key) && !stayed.contains(part.key.as_str()) => {
                edits.push(edit(part, EditOp::Moved, Some(was), Some(part)));
            }
            Some(_) => {}
        }
    }
    edits
}

/// Parts whose order does not count: a review's comments, a mail's
/// recipients.
fn unordered(kind: &str, key: &str) -> bool {
    match kind {
        GITHUB_REVIEW => key.starts_with(COMMENT),
        MAIL | PAGE_ISSUE => key.starts_with(RECIPIENT),
        _ => false,
    }
}

fn same(a: &Part, b: &Part) -> bool {
    a.role == b.role && a.meta == b.meta && normalize(&a.text) == normalize(&b.text)
}

/// The keys of `doc`'s parts whose order counts and that `other` holds too,
/// in their order.
fn ordered_keys<'a>(doc: &'a ResultDoc, kind: &str, other: &HashMap<&str, &Part>) -> Vec<&'a str> {
    doc.parts
        .iter()
        .map(|part| part.key.as_str())
        .filter(|key| !unordered(kind, key) && other.contains_key(key))
        .collect()
}

/// Of the keys both orders hold, the most that keep their order from
/// `before` to `after`; the others moved. Among runs as long, the one that
/// ends last in `after`.
fn kept_in_order<'a>(before: &[&str], after: &[&'a str]) -> HashSet<&'a str> {
    let place: HashMap<&str, usize> = before.iter().enumerate().map(|(at, key)| (*key, at)).collect();
    let places: Vec<(usize, &str)> = after.iter().filter_map(|key| place.get(key).map(|at| (*at, *key))).collect();
    // The longest run of rising old places: `ends[n]` is where the best run
    // of n + 1 ends, `previous[i]` the step before `i` on its run.
    let mut ends: Vec<usize> = Vec::new();
    let mut previous: Vec<Option<usize>> = vec![None; places.len()];
    for (i, (at, _)) in places.iter().enumerate() {
        let len = ends.partition_point(|end| places[*end].0 < *at);
        previous[i] = len.checked_sub(1).map(|n| ends[n]);
        if len == ends.len() {
            ends.push(i);
        } else {
            ends[len] = i;
        }
    }
    let mut kept = HashSet::new();
    let mut step = ends.last().copied();
    while let Some(i) = step {
        kept.insert(places[i].1);
        step = previous[i];
    }
    kept
}

#[cfg(test)]
mod tests;
