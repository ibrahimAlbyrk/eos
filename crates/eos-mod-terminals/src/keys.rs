//! Keystrokes that drive Claude Code's terminal UI, as ordered steps. Each step
//! is written on its own with a pause after it ([`step_gap`]): the TUI reads a
//! burst of keys arriving together as one paste. Verified against Claude Code
//! 2.1.x:
//! - A bracketed paste lands in the composer without submitting (multi-line
//!   safe); Enter on its own then submits.
//! - AskUserQuestion: a single-select question's option digit picks it and
//!   moves on; a multi-select's digits toggle and → moves on. "Type
//!   something" is the digit after the last option: it focuses a text field,
//!   typed text + Enter confirms. With several questions, or any
//!   multi-select, a review step follows whose focused "Submit answers"
//!   takes Enter.
//! - ExitPlanMode: option 1 is always an approving "Yes".

use std::time::Duration;

use eos_contracts::PtyQuestionAnswer;

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";
const ENTER: &str = "\r";
const RIGHT: &str = "\x1b[C";

/// Keys are only meant for Claude's TUI: once Claude exits, the pane is a
/// shell again, where a pasted prompt + Enter would run as a command.
pub(crate) fn is_shell_process(name: &str) -> bool {
    const SHELLS: [&str; 10] = ["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login"];
    let base = name.rsplit('/').next().unwrap_or_default();
    SHELLS.contains(&base.strip_prefix('-').unwrap_or(base))
}

pub(crate) fn step_gap(step: &str) -> Duration {
    Duration::from_millis(if step.starts_with(PASTE_START) { 300 } else { 150 })
}

pub(crate) fn prompt_steps(text: &str) -> Vec<String> {
    vec![format!("{PASTE_START}{text}{PASTE_END}"), ENTER.to_owned()]
}

pub(crate) fn approve_plan_steps() -> Vec<String> {
    vec!["1".to_owned()]
}

/// What the keys address in one question of an AskUserQuestion call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct QuestionShape {
    pub(crate) multi_select: bool,
    pub(crate) option_count: usize,
}

/// The answers do not fit the dialog; the message is the route's 400.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AnswerShapeError(pub(crate) String);

fn digit(index: usize) -> String {
    (index + 1).to_string()
}

pub(crate) fn answer_steps(
    questions: &[QuestionShape],
    answers: &[PtyQuestionAnswer],
) -> Result<Vec<String>, AnswerShapeError> {
    let fail = |message: String| Err(AnswerShapeError(message));
    if answers.len() != questions.len() {
        return fail(format!("expected {} answers, got {}", questions.len(), answers.len()));
    }
    let mut steps = Vec::new();
    for (i, (q, answer)) in questions.iter().zip(answers).enumerate() {
        let n = i + 1;
        // Digits address options, and one more digit is "Type something".
        if q.option_count > 8 {
            return fail(format!("question {n} has too many options to select by key"));
        }
        match answer {
            PtyQuestionAnswer::Text(answer) => {
                if q.multi_select {
                    return fail(format!("question {n} is multi-select: free text is not supported"));
                }
                // A newline would confirm early; the field is single-line anyway.
                let text = one_line(&answer.text);
                if text.is_empty() {
                    return fail(format!("question {n}: empty answer"));
                }
                steps.extend([digit(q.option_count), text, ENTER.to_owned()]);
            }
            PtyQuestionAnswer::Options(answer) => {
                let mut picks: Vec<i64> = Vec::new();
                for option in &answer.options {
                    if !picks.contains(option) {
                        picks.push(*option);
                    }
                }
                if picks.iter().any(|o| usize::try_from(*o).map_or(true, |o| o >= q.option_count)) {
                    return fail(format!("question {n}: no such option"));
                }
                if !q.multi_select && picks.len() != 1 {
                    return fail(format!("question {n} takes exactly one option"));
                }
                steps.extend(picks.iter().map(|o| digit(usize::try_from(*o).unwrap_or(0))));
                if q.multi_select {
                    steps.push(RIGHT.to_owned());
                }
            }
        }
    }
    if questions.len() > 1 || questions.iter().any(|q| q.multi_select) {
        steps.push(ENTER.to_owned());
    }
    Ok(steps)
}

/// Runs of control characters become one space; the ends are trimmed.
fn one_line(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for c in text.chars() {
        if c <= '\x1f' || c == '\x7f' {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    eos_domain::text::js_trim(&out).to_owned()
}
