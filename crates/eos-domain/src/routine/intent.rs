//! What a sentence typed at Home asks for, by rules alone (01 §4.13): run
//! one of the user's routines, make one, change one or do the task once.
//! English only. A forced mode or a picked routine decides; a named
//! routine with change words is a change, and with an item its routine
//! takes, a run; an item exactly one routine recognises is a run of it;
//! repetition or condition words make a routine; the bare name of a
//! routine runs it on its latest. Anything else is not certain, and the
//! choices say what it might be.

use eos_contracts::{IntentChoice, IntentKind};
use regress::Regex;

use crate::text::js_re;

/// A routine as the rules read it.
#[derive(Debug, Clone)]
pub struct Known {
    pub id: String,
    pub name: String,
    pub slug: String,
    pub aliases: Vec<String>,
    /// What recognises one of its items in a link or a text.
    pub patterns: Vec<Regex>,
}

impl Known {
    /// Compiles `patterns` as JavaScript reads them, leaving out any that
    /// does not compile.
    pub fn new(id: &str, name: &str, slug: &str, aliases: &[String], patterns: &[String]) -> Self {
        Self {
            id: id.to_owned(),
            name: name.to_owned(),
            slug: slug.to_owned(),
            aliases: aliases.to_vec(),
            patterns: patterns.iter().filter_map(|pattern| Regex::new(pattern).ok()).collect(),
        }
    }

    /// Whether a JavaScript engine compiles `pattern` as the rules do.
    pub fn compiles(pattern: &str) -> bool {
        Regex::new(pattern).is_ok()
    }

    /// The first part of `text` one of its patterns matches.
    pub fn item_in<'t>(&self, text: &'t str) -> Option<&'t str> {
        self.patterns.iter().find_map(|re| re.find(text).map(|found| text[found.range()].trim()))
    }
}

/// What the user asked, beside their routines.
#[derive(Debug, Clone, Copy, Default)]
pub struct Asked<'a> {
    pub text: &'a str,
    /// The values of the things given with it (links, paths).
    pub attachments: &'a [String],
    pub forced: Option<IntentKind>,
    /// The routine token picked.
    pub routine_id: Option<&'a str>,
}

/// The rules' reading.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reading {
    pub intent: IntentKind,
    pub certain: bool,
    pub line: String,
    pub routine_id: Option<String>,
    /// The item's text as written (`#470`, a link).
    pub item: Option<String>,
    pub alternatives: Vec<IntentChoice>,
}

/// The most choices an unsure reading gives.
pub const CHOICES_MAX: usize = 3;

pub const MAKE_LINE: &str = "Make a new routine. You see its blueprint and a trial first";
pub const ONCE_LINE: &str = "Do it once, here";
pub const UNSURE_LINE: &str = "Which one?";

/// The line of a run of `name`, on `item` or its latest.
pub fn run_line(name: &str, item: Option<&str>) -> String {
    match item {
        Some(item) => format!("Run {name} on {item}"),
        None => format!("Run {name} on the latest"),
    }
}

pub fn change_line(name: &str) -> String {
    format!("Change {name}")
}

pub fn choice(intent: IntentKind, routine: Option<&Known>, item: Option<&str>) -> IntentChoice {
    let line = match (intent, routine) {
        (IntentKind::Run, Some(routine)) => run_line(&routine.name, item),
        (IntentKind::Change, Some(routine)) => change_line(&routine.name),
        (IntentKind::Make, _) => MAKE_LINE.to_owned(),
        (IntentKind::Once, _) => ONCE_LINE.to_owned(),
        _ => UNSURE_LINE.to_owned(),
    };
    let routine_id =
        routine.filter(|_| matches!(intent, IntentKind::Run | IntentKind::Change)).map(|routine| routine.id.clone());
    IntentChoice { intent, line, routine_id }
}

/// Reads `asked` against the user's routines.
pub fn read(asked: &Asked<'_>, routines: &[Known]) -> Reading {
    let text = asked.text.trim();
    let lower = text.to_lowercase();
    let mut haystack = text.to_owned();
    for value in asked.attachments {
        haystack.push(' ');
        haystack.push_str(value);
    }
    let picked = asked.routine_id.and_then(|id| routines.iter().find(|routine| routine.id == id));
    let named: Vec<&Known> = routines.iter().filter(|routine| names(routine, &lower)).collect();
    let routine = picked.or(match named.as_slice() {
        [one] => Some(*one),
        _ => None,
    });
    let item_of = |routine: &Known| routine.item_in(&haystack).map(str::to_owned);

    let recognising: Vec<&Known> = routines.iter().filter(|routine| routine.item_in(&haystack).is_some()).collect();
    if let Some(forced) = asked.forced.filter(|forced| *forced != IntentKind::Unsure) {
        let needs_routine = matches!(forced, IntentKind::Run | IntentKind::Change);
        // A forced run that names no routine may still hold one routine's
        // item; past that the rules cannot honour the mode, so they only
        // offer choices.
        let routine = routine.or(match recognising.as_slice() {
            [one] if forced == IntentKind::Run => Some(*one),
            _ => None,
        });
        if needs_routine && routine.is_none() {
            return unsure(named.iter().chain(&recognising).copied(), &haystack);
        }
        return sure(forced, routine, routine.and_then(item_of));
    }
    if let Some(routine) = picked {
        let intent = if changes(&lower) { IntentKind::Change } else { IntentKind::Run };
        return sure(intent, Some(routine), item_of(routine));
    }
    if let Some(routine) = routine {
        if changes(&lower) {
            return sure(IntentKind::Change, Some(routine), None);
        }
        if let Some(item) = item_of(routine) {
            return sure(IntentKind::Run, Some(routine), Some(item));
        }
    }
    if let [one] = recognising.as_slice() {
        return sure(IntentKind::Run, Some(*one), item_of(one));
    }
    if repeats(&lower) {
        return sure(IntentKind::Make, None, None);
    }
    if let Some(routine) = routine.filter(|routine| is_name(routine, &lower)) {
        return sure(IntentKind::Run, Some(routine), None);
    }
    unsure(named.iter().chain(&recognising).copied(), &haystack)
}

fn sure(intent: IntentKind, routine: Option<&Known>, item: Option<String>) -> Reading {
    let chosen = choice(intent, routine, item.as_deref());
    let other = if intent == IntentKind::Once { IntentKind::Make } else { IntentKind::Once };
    Reading {
        intent,
        certain: true,
        line: chosen.line,
        routine_id: chosen.routine_id,
        item: item.filter(|_| intent == IntentKind::Run),
        alternatives: vec![choice(other, None, None)],
    }
}

/// Not sure: a run of each routine the text names or whose item it holds,
/// then making a routine and doing it once, at most [`CHOICES_MAX`].
pub fn unsure<'a>(candidates: impl Iterator<Item = &'a Known>, haystack: &str) -> Reading {
    let mut choices: Vec<IntentChoice> = Vec::new();
    for routine in candidates {
        if choices.iter().all(|choice| choice.routine_id.as_deref() != Some(&routine.id)) {
            choices.push(choice(IntentKind::Run, Some(routine), routine.item_in(haystack)));
        }
    }
    choices.push(choice(IntentKind::Make, None, None));
    choices.push(choice(IntentKind::Once, None, None));
    choices.truncate(CHOICES_MAX);
    Reading {
        intent: IntentKind::Unsure,
        certain: false,
        line: UNSURE_LINE.to_owned(),
        routine_id: None,
        item: None,
        alternatives: choices,
    }
}

/// `lower` holds `phrase` as whole words.
fn holds(lower: &str, phrase: &str) -> bool {
    let phrase = phrase.trim().to_lowercase();
    if phrase.is_empty() {
        return false;
    }
    let word = |c: char| c.is_alphanumeric();
    lower.match_indices(&phrase).any(|(at, _)| {
        let before = lower[..at].chars().next_back();
        let after = lower[at + phrase.len()..].chars().next();
        !before.is_some_and(word) && !after.is_some_and(word)
    })
}

/// The text names the routine: its name, slug or an alias.
fn names(routine: &Known, lower: &str) -> bool {
    holds(lower, &routine.name)
        || holds(lower, &routine.slug)
        || routine.aliases.iter().any(|alias| holds(lower, alias))
}

/// The text is nothing but the routine's name, slug or an alias.
fn is_name(routine: &Known, lower: &str) -> bool {
    let bare = lower.trim_matches(|c: char| !c.is_alphanumeric());
    let is = |name: &str| !name.is_empty() && bare == name.to_lowercase();
    is(&routine.name) || is(&routine.slug) || routine.aliases.iter().any(|alias| is(alias))
}

const CHANGE_WORDS: &[&str] =
    &["should also", "should not", "shouldn't", "should", "stop", "never", "change", "no longer", "don't", "instead"];

fn changes(lower: &str) -> bool {
    CHANGE_WORDS.iter().any(|words| holds(lower, words))
}

const REPEAT_WORDS: &[&str] = &[
    "every",
    "whenever",
    "each morning",
    "each evening",
    "each day",
    "each week",
    "each month",
    "daily",
    "weekly",
    "monthly",
    "nightly",
    "hourly",
    "each time",
    "any time",
    "when a",
    "when an",
    "if a",
    "if an",
    "mondays",
    "tuesdays",
    "wednesdays",
    "thursdays",
    "fridays",
    "saturdays",
    "sundays",
    "weekdays",
];

fn repeats(lower: &str) -> bool {
    REPEAT_WORDS.iter().any(|words| holds(lower, words))
        || js_re!(r"\b(at|by) \d{1,2}(:\d{2})?\s*(am|pm)?\b").find(lower).is_some()
        || js_re!(r"\bon (monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b").find(lower).is_some()
}

#[cfg(test)]
mod tests;
