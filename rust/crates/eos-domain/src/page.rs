//! Page bodies are plain markdown. These are the reads and targeted edits over
//! them (`core/src/domain/page.ts`): the list summary (excerpt and checklist
//! counts) and the agent edit operations (append, replace, tick a task), which
//! apply to the latest body so an agent's edit never overwrites what the user
//! typed meanwhile. Lines inside fenced code blocks are never headings or tasks.
//!
//! The patterns are the JavaScript ones, run by a JavaScript regex engine, so a
//! line counts as a task or a heading here exactly when it did before.

use std::fmt;

use eos_contracts::{PageEditRequest, PageSummaryTasks};

use crate::text::{collapse_spaces, js_re, js_trim, js_trim_end, utf16_len, utf16_prefix};

/// The longest excerpt a list row shows, in UTF-16 units.
pub const EXCERPT_MAX: usize = 160;

/// Why a targeted edit cannot be applied. The text is what the agent reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageEditError {
    NothingToAppend,
    OldTextNotFound,
    OldTextRepeats {
        count: usize,
    },
    NoSuchTask {
        task: String,
    },
    /// `names`: up to five of the matching items, each quoted.
    AmbiguousTask {
        task: String,
        count: usize,
        names: String,
    },
}

impl fmt::Display for PageEditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NothingToAppend => f.write_str("nothing to append"),
            Self::OldTextNotFound => {
                f.write_str("old text was not found on the page — read the page again and copy the passage exactly")
            }
            Self::OldTextRepeats { count } => {
                write!(f, "old text appears {count} times — include more of the surrounding text so it matches once")
            }
            Self::NoSuchTask { task } => write!(f, "no checklist item matches \"{task}\""),
            Self::AmbiguousTask { task, count, names } => {
                write!(f, "\"{task}\" matches {count} checklist items ({names}) — use the item's full text")
            }
        }
    }
}

impl std::error::Error for PageEditError {}

fn task_re() -> &'static regress::Regex {
    js_re!(r"^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*)$")
}

fn heading_re() -> &'static regress::Regex {
    js_re!(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
}

fn list_item_re() -> &'static regress::Regex {
    js_re!(r"^\s*(?:[-*+]|\d+[.)])\s")
}

fn group<'t>(m: &regress::Match, text: &'t str, index: usize) -> &'t str {
    m.group(index).map_or("", |range| &text[range])
}

/// Per line: true when it sits inside (or opens or closes) a fenced code block.
fn fenced_lines(lines: &[&str]) -> Vec<bool> {
    let fence = js_re!(r"^\s*(```|~~~)");
    let mut open: Option<&str> = None;
    lines
        .iter()
        .map(|line| {
            let marker = fence.find(line).map(|m| group(&m, line, 1));
            match (open, marker) {
                (Some(opened), _) => {
                    if marker == Some(opened) {
                        open = None;
                    }
                    true
                }
                (None, Some(marker)) => {
                    open = Some(marker);
                    true
                }
                (None, None) => false,
            }
        })
        .collect()
}

/// The comparison key of a heading or a task: trimmed, inner whitespace
/// collapsed, lowercase.
fn norm(s: &str) -> String {
    collapse_spaces(js_trim(s)).to_lowercase()
}

/// Open and ticked checklist items outside code fences.
pub fn page_task_counts(body: &str) -> PageSummaryTasks {
    let lines: Vec<&str> = body.split('\n').collect();
    let fenced = fenced_lines(&lines);
    let mut tasks = PageSummaryTasks { open: 0, done: 0 };
    for (line, fenced) in lines.iter().zip(fenced) {
        if fenced {
            continue;
        }
        if let Some(m) = task_re().find(line) {
            if group(&m, line, 2) == " " {
                tasks.open += 1;
            } else {
                tasks.done += 1;
            }
        }
    }
    tasks
}

/// The first prose of the page with the markdown markers stripped, for list
/// rows; at most `max` UTF-16 units, cut with an ellipsis.
pub fn page_excerpt(body: &str, max: usize) -> String {
    let lead = js_re!(r"^\s*(?:[-*+]\s+\[[ xX]\]|[-*+]|\d+[.)]|>)\s*");
    let lines: Vec<&str> = body.split('\n').collect();
    let fenced = fenced_lines(&lines);
    let mut parts: Vec<String> = Vec::new();
    let mut len = 0;
    for (line, fenced) in lines.iter().zip(fenced) {
        if len >= max {
            break;
        }
        if fenced || heading_re().find(line).is_some() {
            continue;
        }
        let rest = lead.find(line).map_or(*line, |m| &line[m.end()..]);
        let plain: String = rest.chars().filter(|c| !matches!(c, '*' | '_' | '`' | '~')).collect();
        let text = js_trim(&plain);
        if text.is_empty() {
            continue;
        }
        len += utf16_len(text) + 1;
        parts.push(text.to_owned());
    }
    let joined = parts.join(" ");
    if utf16_len(&joined) > max {
        format!("{}…", js_trim_end(utf16_prefix(&joined, max.saturating_sub(1))))
    } else {
        joined
    }
}

/// Applies one targeted edit to `body` and returns the new body.
pub fn apply_page_edit(body: &str, edit: &PageEditRequest) -> Result<String, PageEditError> {
    match edit {
        PageEditRequest::Append(e) => append_to_page(body, &e.text, e.heading.as_deref()),
        PageEditRequest::Replace(e) => replace_in_page(body, &e.old_text, &e.new_text),
        PageEditRequest::SetTask(e) => set_page_task(body, &e.task, e.done),
    }
}

/// Two adjacent list items stay one list; anything else gets a blank line between.
fn join_blocks(before: &str, text: &str) -> String {
    if js_trim(before).is_empty() {
        return text.to_owned();
    }
    let last_line = before.rsplit('\n').next().unwrap_or(before);
    let one_list = list_item_re().find(last_line).is_some() && list_item_re().find(text).is_some();
    format!("{before}{}{text}", if one_list { "\n" } else { "\n\n" })
}

/// `heading.replace(/^#+\s*/, "")`.
fn without_hashes(heading: &str) -> &str {
    match heading.strip_prefix('#') {
        Some(rest) => rest.trim_start_matches('#').trim_start_matches(crate::text::is_js_space),
        None => heading,
    }
}

fn append_to_page(body: &str, raw_text: &str, heading: Option<&str>) -> Result<String, PageEditError> {
    let text = js_trim_end(raw_text.trim_start_matches('\n'));
    if text.is_empty() {
        return Err(PageEditError::NothingToAppend);
    }
    let Some(heading) = heading.filter(|h| !h.is_empty()) else {
        return Ok(format!("{}\n", join_blocks(js_trim_end(body), text)));
    };

    let lines: Vec<&str> = body.split('\n').collect();
    let fenced = fenced_lines(&lines);
    // A heading line outside a fence, as (hash count, title).
    let heading_at = |i: usize| -> Option<(usize, &str)> {
        if fenced[i] {
            return None;
        }
        heading_re().find(lines[i]).map(|m| (group(&m, lines[i], 1).len(), group(&m, lines[i], 2)))
    };
    let target = norm(without_hashes(heading));
    let found = (0..lines.len()).find_map(|i| match heading_at(i) {
        Some((level, title)) if norm(title) == target => Some((i, level)),
        _ => None,
    });
    let Some((at, level)) = found else {
        let title = js_trim(without_hashes(heading));
        return Ok(format!("{}\n\n{text}\n", join_blocks(js_trim_end(body), &format!("## {title}"))));
    };

    // The section runs to the next heading of the same or a higher level.
    let end =
        (at + 1..lines.len()).find(|i| heading_at(*i).is_some_and(|(other, _)| other <= level)).unwrap_or(lines.len());
    let section = lines[..end].join("\n");
    let rest = lines[end..].join("\n");
    let rest = rest.trim_start_matches('\n');
    let merged = join_blocks(js_trim_end(&section), text);
    Ok(if rest.is_empty() { format!("{merged}\n") } else { format!("{merged}\n\n{}\n", js_trim_end(rest)) })
}

fn replace_in_page(body: &str, old_text: &str, new_text: &str) -> Result<String, PageEditError> {
    let Some(first) = body.find(old_text) else {
        return Err(PageEditError::OldTextNotFound);
    };
    // Occurrences that do not overlap, as `indexOf(old, i + old.length)` walks them.
    let count = if old_text.is_empty() { 1 } else { body.matches(old_text).count() };
    if count > 1 {
        return Err(PageEditError::OldTextRepeats { count });
    }
    Ok(format!("{}{new_text}{}", &body[..first], &body[first + old_text.len()..]))
}

fn set_page_task(body: &str, task: &str, done: bool) -> Result<String, PageEditError> {
    let marker = js_re!(r"^\s*[-*+]\s+\[[ xX]\]\s*");
    let mut lines: Vec<&str> = body.split('\n').collect();
    let fenced = fenced_lines(&lines);
    let want = norm(marker.find(task).map_or(task, |m| &task[m.end()..]));

    // Every checklist item: its line and its text.
    let items: Vec<(usize, &str)> = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| !fenced[*i])
        .filter_map(|(i, line)| task_re().find(line).map(|m| (i, group(&m, line, 4))))
        .collect();
    let exact: Vec<&(usize, &str)> = items.iter().filter(|(_, text)| norm(text) == want).collect();
    let hits =
        if exact.is_empty() { items.iter().filter(|(_, text)| norm(text).contains(&want)).collect() } else { exact };
    let line = match hits.as_slice() {
        [] => return Err(PageEditError::NoSuchTask { task: task.to_owned() }),
        [(line, _)] => *line,
        many => {
            let names: Vec<String> = many.iter().take(5).map(|(_, text)| format!("\"{}\"", js_trim(text))).collect();
            return Err(PageEditError::AmbiguousTask {
                task: task.to_owned(),
                count: many.len(),
                names: names.join(", "),
            });
        }
    };

    let old = lines[line];
    let ticked = task_re().find(old).map(|m| {
        let (pre, mid, rest) = (group(&m, old, 1), group(&m, old, 3), group(&m, old, 4));
        format!("{pre}{}{mid}{rest}", if done { "x" } else { " " })
    });
    let ticked = ticked.unwrap_or_else(|| old.to_owned());
    lines[line] = &ticked;
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use eos_contracts::{PageEditRequestAppend, PageEditRequestReplace, PageEditRequestSetTask};

    use super::*;

    const BODY: &str = "Intro line with **bold**.\n\n## Tasks\n\n- [x] Ground probe per foot\n- [ ] Clamp hip offset on stairs\n- [ ] Blend IK weight\n\n```md\n- [ ] not a task\n## not a heading\n```\n\n## Notes\n\nKeep the solver pure.\n";

    fn append(body: &str, text: &str, heading: Option<&str>) -> Result<String, PageEditError> {
        let edit = PageEditRequestAppend { text: text.to_owned(), heading: heading.map(str::to_owned) };
        apply_page_edit(body, &PageEditRequest::Append(edit))
    }

    fn replace(body: &str, old: &str, new: &str) -> Result<String, PageEditError> {
        let edit = PageEditRequestReplace { old_text: old.to_owned(), new_text: new.to_owned() };
        apply_page_edit(body, &PageEditRequest::Replace(edit))
    }

    fn set_task(body: &str, task: &str, done: bool) -> Result<String, PageEditError> {
        apply_page_edit(body, &PageEditRequest::SetTask(PageEditRequestSetTask { task: task.to_owned(), done }))
    }

    #[test]
    fn counts_checklist_items_outside_code_fences() {
        assert_eq!(page_task_counts(BODY), PageSummaryTasks { open: 2, done: 1 });
    }

    #[test]
    fn excerpts_prose_without_markdown_markers() {
        assert_eq!(page_excerpt("# Title\n\n- [ ] first *thing*\n> quoted", EXCERPT_MAX), "first thing quoted");
        assert_eq!(page_excerpt(&"x".repeat(300), 10), format!("{}…", "x".repeat(9)));
    }

    #[test]
    fn appends_at_the_end_keeping_a_list_together() {
        assert_eq!(append("", "hello", None).as_deref(), Ok("hello\n"));
        assert_eq!(append("- [ ] a\n", "- [ ] b", None).as_deref(), Ok("- [ ] a\n- [ ] b\n"));
        assert_eq!(append("para\n", "more", None).as_deref(), Ok("para\n\nmore\n"));
        assert_eq!(append("para\n", "\n \n", None), Err(PageEditError::NothingToAppend));
    }

    #[test]
    fn appends_to_the_end_of_a_headings_section() {
        let out = append(BODY, "- [ ] New task", Some("tasks")).expect("appended");
        assert!(out.contains("```\n\n- [ ] New task\n\n## Notes\n\nKeep the solver pure.\n"), "{out}");
        let list = append("## Tasks\n\n- [ ] a\n\n## Next\n", "- [ ] b", Some("Tasks"));
        assert_eq!(list.as_deref(), Ok("## Tasks\n\n- [ ] a\n- [ ] b\n\n## Next\n"));
    }

    #[test]
    fn creates_a_missing_heading_at_the_end() {
        assert_eq!(append("para\n", "found it", Some("Findings")).as_deref(), Ok("para\n\n## Findings\n\nfound it\n"));
    }

    #[test]
    fn ignores_a_heading_looking_line_inside_a_fence() {
        let out = append(BODY, "x", Some("not a heading")).expect("appended");
        assert!(out.ends_with("## not a heading\n\nx\n"), "{out}");
    }

    #[test]
    fn replaces_one_exact_passage_refusing_missing_or_ambiguous_text() {
        assert_eq!(replace("a b c", "b", "B").as_deref(), Ok("a B c"));
        assert_eq!(replace("a b c", "z", ""), Err(PageEditError::OldTextNotFound));
        let twice = replace("b b", "b", "").expect_err("ambiguous");
        assert!(twice.to_string().contains("appears 2 times"), "{twice}");
    }

    #[test]
    fn ticks_and_unticks_a_task_by_exact_or_partial_text() {
        let done = set_task(BODY, "clamp hip offset", true).expect("ticked");
        assert!(done.contains("- [x] Clamp hip offset on stairs"));
        let reopened = set_task(BODY, "Ground probe per foot", false).expect("unticked");
        assert!(reopened.contains("- [ ] Ground probe per foot"));
        let none = set_task(BODY, "not a task", true).expect_err("fenced");
        assert_eq!(none.to_string(), "no checklist item matches \"not a task\"");
        let many = set_task(BODY, "e", true).expect_err("ambiguous");
        assert_eq!(
            many.to_string(),
            "\"e\" matches 3 checklist items (\"Ground probe per foot\", \"Clamp hip offset on stairs\", \"Blend IK weight\") — use the item's full text"
        );
    }
}
