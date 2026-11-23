//! A problem the core reports to an agent or the user: where it is, and what is
//! wrong, in one line (`stories[3].title: is 140 characters, max 120`).

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub path: String,
    pub message: String,
}

impl Problem {
    pub fn new(path: impl Into<String>, message: impl Into<String>) -> Self {
        Problem { path: path.into(), message: message.into() }
    }
}

impl fmt::Display for Problem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.path.is_empty() { f.write_str(&self.message) } else { write!(f, "{}: {}", self.path, self.message) }
    }
}

/// Every problem on its own line, as an agent reads them in one answer.
pub fn format_problems(problems: &[Problem]) -> String {
    problems.iter().map(Problem::to_string).collect::<Vec<_>>().join("\n")
}

/// A field below `parent`: `lead` + `title` is `lead.title`; at the top it is
/// just `title`.
pub(crate) fn field_path(parent: &str, name: &str) -> String {
    if parent.is_empty() { name.to_owned() } else { format!("{parent}.{name}") }
}

pub(crate) fn index_path(parent: &str, index: usize) -> String {
    format!("{parent}[{index}]")
}
