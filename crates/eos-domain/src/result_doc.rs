//! A routine run's result (`eos_contracts::ResultDoc`): the parts each kind
//! has, when two versions of a result are the same, and how one became the
//! other. Sameness is what the Freedom streak counts: a result sent as it was
//! drafted, once normalised, went out unedited. Pure; a result is the user's
//! text, so nothing here logs.

use std::collections::{HashMap, HashSet};

use eos_contracts::{EditOp, Part, PartEdit, ResultDoc};

pub mod shape;

/// A pull request review: [`EVENT`], [`SUMMARY`] and a [`comment_key`] per
/// line comment, whose meta holds its `path`, `line` and `side`. Its
/// comments are a set: their order does not count.
pub const GITHUB_REVIEW: &str = "github.review";
/// A mail: [`SUBJECT`], a [`paragraph_key`] per paragraph, in order, and a
/// [`recipient_key`] per recipient, as a set.
pub const MAIL: &str = "mail";
/// An issue of a Page: one part per field of the Page's contract, keyed by
/// the field's path (`stories[3].title`), in order.
pub const PAGE_ISSUE: &str = "page.issue";
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
        MAIL => key.starts_with(RECIPIENT),
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
