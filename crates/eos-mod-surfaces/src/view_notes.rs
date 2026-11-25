//! What a returned View may say beside itself (SurfaceDecision): facts in
//! the cards of a Choice's options, and short titled notes beside the View.
//! Eos draws both in its own frame, so they hold plain text only: no markup,
//! no link, nothing that could read as a button or an action. The View's
//! catalog stays as it is; these travel next to it.

use eos_contracts::{AsideNote, FactRow, OptionFacts};
use eos_genui::attrs::parse_options;
use eos_genui::markup::{parse_markup, walk_markup};
use eos_surface::Problem;
use serde_json::Value;

const ROWS_MAX: usize = 3;
const NOTES_MAX: usize = 2;
const OPTION_CHARS: usize = 80;
const LABEL_CHARS: usize = 24;
const VALUE_CHARS: usize = 60;
const TITLE_CHARS: usize = 40;
const TEXT_CHARS: usize = 300;

/// Characters that make markup in the View's text or in the dashboard's.
const MARKUP: &[char] = &['<', '>', '[', ']', '{', '}', '`', '*', '\\'];
/// Schemes a link starts with when it has no `://`.
const SCHEMES: &[&str] = &["mailto:", "javascript:", "vbscript:", "data:", "file:", "tel:", "sms:"];

/// What a View holds beside itself, checked.
pub(crate) struct Notes {
    pub(crate) facts: Option<Vec<OptionFacts>>,
    pub(crate) aside: Option<Vec<AsideNote>>,
}

/// The facts and the notes, or every problem with its path.
pub(crate) fn checked(view: &Value, facts: Option<&Value>, aside: Option<&Value>) -> Result<Notes, Vec<Problem>> {
    let mut problems = Vec::new();
    let facts = facts.filter(|f| !f.is_null()).map(|f| read_facts(view, f, &mut problems));
    let aside = aside.filter(|a| !a.is_null()).map(|a| read_aside(a, &mut problems));
    if problems.is_empty() { Ok(Notes { facts, aside }) } else { Err(problems) }
}

/// Every option label and value of the View's Choices.
fn choice_options(view: &Value) -> Vec<String> {
    let parsed = parse_markup(view["ui"].as_str().unwrap_or_default());
    let mut names = Vec::new();
    walk_markup(&parsed.nodes, |el, _, _| {
        if el.name == "Choice" {
            for option in parse_options(el.attr("options")) {
                names.push(option.label);
                names.push(option.value);
            }
        }
    });
    names
}

fn read_facts(view: &Value, facts: &Value, problems: &mut Vec<Problem>) -> Vec<OptionFacts> {
    let Some(entries) = facts.as_array() else {
        problems.push(Problem::new("facts", "must be a list of {option, rows}"));
        return Vec::new();
    };
    let options = choice_options(view);
    let mut named: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (i, entry) in entries.iter().enumerate() {
        let path = format!("facts[{i}]");
        let option = text(&entry["option"], &format!("{path}.option"), OPTION_CHARS, problems);
        if let Some(option) = option.as_deref() {
            if !options.iter().any(|o| o == option) {
                problems.push(Problem::new(format!("{path}.option"), "is not an option of a Choice in the view"));
            } else if named.iter().any(|n| n == option) {
                problems.push(Problem::new(format!("{path}.option"), "has its facts already"));
            }
        }
        let rows = match entry["rows"].as_array() {
            Some(rows) if (1..=ROWS_MAX).contains(&rows.len()) => rows,
            _ => {
                problems
                    .push(Problem::new(format!("{path}.rows"), format!("must hold 1 to {ROWS_MAX} {{label, value}}")));
                continue;
            }
        };
        let rows: Vec<FactRow> = rows
            .iter()
            .enumerate()
            .filter_map(|(j, row)| {
                let at = format!("{path}.rows[{j}]");
                let label = text(&row["label"], &format!("{at}.label"), LABEL_CHARS, problems);
                let value = text(&row["value"], &format!("{at}.value"), VALUE_CHARS, problems);
                Some(FactRow { label: label?, value: value? })
            })
            .collect();
        if let Some(option) = option {
            named.push(option.clone());
            out.push(OptionFacts { option, rows });
        }
    }
    out
}

fn read_aside(aside: &Value, problems: &mut Vec<Problem>) -> Vec<AsideNote> {
    let notes = match aside.as_array() {
        Some(notes) if notes.len() <= NOTES_MAX => notes,
        _ => {
            problems.push(Problem::new("aside", format!("must be a list of at most {NOTES_MAX} {{title, text}}")));
            return Vec::new();
        }
    };
    notes
        .iter()
        .enumerate()
        .filter_map(|(i, note)| {
            let title = text(&note["title"], &format!("aside[{i}].title"), TITLE_CHARS, problems);
            let body = text(&note["text"], &format!("aside[{i}].text"), TEXT_CHARS, problems);
            Some(AsideNote { title: title?, text: body? })
        })
        .collect()
}

/// The text, trimmed, when it is one short line of plain words.
fn text(value: &Value, path: &str, max: usize, problems: &mut Vec<Problem>) -> Option<String> {
    let trimmed = value.as_str().map(str::trim).unwrap_or_default();
    let problem = if trimmed.is_empty() {
        Some(format!("is required: up to {max} characters of plain text"))
    } else if trimmed.chars().count() > max {
        Some(format!("is longer than {max} characters"))
    } else if !is_plain(trimmed) {
        Some("must be plain text: no markup, no link, one line".to_owned())
    } else {
        None
    };
    match problem {
        Some(message) => {
            problems.push(Problem::new(path, message));
            None
        }
        None => Some(trimmed.to_owned()),
    }
}

fn is_plain(text: &str) -> bool {
    let lower = text.to_lowercase();
    let starts_link = |at: usize| at == 0 || !lower[..at].chars().next_back().is_some_and(char::is_alphanumeric);
    let scheme = SCHEMES.iter().any(|s| lower.match_indices(s).any(|(at, _)| starts_link(at)));
    let www = lower.match_indices("www.").any(|(at, _)| starts_link(at));
    !scheme
        && !www
        && !lower.contains("://")
        && !text.chars().any(|c| MARKUP.contains(&c) || c.is_control() || is_direction_mark(c))
}

/// Marks that turn the direction of the text around it, which can make it
/// read as something it is not.
fn is_direction_mark(c: char) -> bool {
    matches!(c, '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}
