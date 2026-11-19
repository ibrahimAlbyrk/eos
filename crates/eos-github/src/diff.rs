//! Which lines of a pull request's diff a review comment can sit on (06
//! G18). GitHub refuses a whole review, body included, when one comment is
//! on a line or a file outside the diff, so such comments are moved into the
//! review's body under "Notes on other lines" before it is sent.

use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::actions::text;

/// The lines each changed file shows in the diff, by side: `RIGHT` the new
/// file's line numbers (context and added), `LEFT` the old one's (context
/// and removed).
#[derive(Debug, Default)]
pub(crate) struct DiffLines {
    files: HashMap<String, (HashSet<u64>, HashSet<u64>)>,
}

/// `@@ -12,5 +14,6 @@` → (12, 14).
fn hunk_start(line: &str) -> Option<(u64, u64)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let new = rest.split_once(' ').map_or(rest, |(new, _)| new);
    let first = |range: &str| range.split(',').next()?.parse::<u64>().ok();
    Some((first(old)?, first(new)?))
}

impl DiffLines {
    /// From GitHub's file list: each file's `filename` and `patch`. A file
    /// without a patch (binary, too large) shows no lines.
    pub(crate) fn of(files: &[Value]) -> Self {
        let mut lines = DiffLines::default();
        for file in files {
            let (left, right) = lines.files.entry(text(file, "filename").to_owned()).or_default();
            let (mut old, mut new) = (0, 0);
            for line in text(file, "patch").lines() {
                if let Some((o, n)) = hunk_start(line) {
                    (old, new) = (o, n);
                    continue;
                }
                match line.chars().next() {
                    Some('+') => {
                        right.insert(new);
                        new += 1;
                    }
                    Some('-') => {
                        left.insert(old);
                        old += 1;
                    }
                    Some('\\') => {}
                    _ => {
                        left.insert(old);
                        right.insert(new);
                        old += 1;
                        new += 1;
                    }
                }
            }
        }
        lines
    }

    /// Whether GitHub can place `comment` (its `path`, `line`, `side` and
    /// `startLine`).
    fn shows(&self, comment: &Value) -> bool {
        let Some((left, right)) = self.files.get(text(comment, "path")) else { return false };
        let side = if text(comment, "side") == "LEFT" { left } else { right };
        let line = comment["line"].as_u64();
        let start = comment["startLine"].as_u64();
        line.is_some_and(|line| side.contains(&line)) && start.is_none_or(|start| side.contains(&start))
    }
}

/// The comments GitHub can place, in its own shape, and a note for each of
/// the others.
pub(crate) fn place(comments: &[Value], lines: &DiffLines) -> (Vec<Value>, Vec<String>) {
    let (mut placed, mut notes) = (Vec::new(), Vec::new());
    for comment in comments {
        if !lines.shows(comment) {
            let at = match comment["startLine"].as_u64() {
                Some(start) => format!("lines {start}-{}", comment["line"]),
                None => format!("line {}", comment["line"]),
            };
            notes.push(format!("- `{}` {at}: {}", text(comment, "path"), text(comment, "body")));
            continue;
        }
        let side = if text(comment, "side") == "LEFT" { "LEFT" } else { "RIGHT" };
        let mut out =
            json!({ "path": comment["path"], "line": comment["line"], "side": side, "body": comment["body"] });
        if let Some(start) = comment["startLine"].as_u64() {
            out["start_line"] = start.into();
            out["start_side"] = side.into();
        }
        placed.push(out);
    }
    (placed, notes)
}

/// The review's body: its text, the notes on other lines, and the marker
/// that lets a repeated send find it.
pub(crate) fn body(text: &str, notes: &[String], marker: Option<&str>) -> String {
    let mut body = text.trim_end().to_owned();
    if !notes.is_empty() {
        body.push_str("\n\n**Notes on other lines**\n\n");
        body.push_str(&notes.join("\n"));
    }
    if let Some(marker) = marker {
        body.push_str("\n\n");
        body.push_str(marker);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hunk_shows_its_context_and_added_lines_on_the_right_and_removed_ones_on_the_left() {
        let files = [json!({
            "filename": "src/a.rs",
            "patch": "@@ -27,7 +27,7 @@ fn main()\n a\n b\n c\n-old\n+new\n d\n e\n\\ No newline at end of file",
        })];
        let lines = DiffLines::of(&files);
        let on = |path: &str, line: u64, side: &str| lines.shows(&json!({ "path": path, "line": line, "side": side }));
        assert!(on("src/a.rs", 30, "RIGHT") && on("src/a.rs", 27, "RIGHT") && on("src/a.rs", 32, "RIGHT"));
        assert!(on("src/a.rs", 30, "LEFT"), "the removed line");
        assert!(!on("src/a.rs", 5, "RIGHT") && !on("src/a.rs", 33, "RIGHT"));
        assert!(!on("README.md", 1, "RIGHT"), "a file the pull request does not change");
        let range = json!({ "path": "src/a.rs", "startLine": 2, "line": 30 });
        assert!(!lines.shows(&range), "a range that starts outside the hunk");

        let comments = [
            json!({ "path": "src/a.rs", "line": 30, "body": "ok" }),
            json!({ "path": "src/a.rs", "line": 5, "body": "far" }),
        ];
        let (placed, notes) = place(&comments, &lines);
        assert_eq!(placed, [json!({ "path": "src/a.rs", "line": 30, "side": "RIGHT", "body": "ok" })]);
        assert_eq!(notes, ["- `src/a.rs` line 5: far"]);
        assert_eq!(
            body("Looks good.\n", &notes, Some("<!-- eos:d:dl-1 -->")),
            "Looks good.\n\n**Notes on other lines**\n\n- `src/a.rs` line 5: far\n\n<!-- eos:d:dl-1 -->"
        );
    }
}
