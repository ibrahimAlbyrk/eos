//! Reflection: the answer a model gives about one moment, what may become a
//! note from it, and the rules that stand in for the model where none may be
//! called (only an API key, a chat on another provider's model, a run that is
//! not the installed app). Outside text never teaches: a lesson that repeats
//! what an outside read said, and not what the user said, is kept only as a
//! short-lived guess.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Value, json};

use super::cues::Cue;
use super::moments::Signal;
use super::note::{HookKind, NoteKind, ScopeLevel, Trust};

/// A note's text, at most.
pub const NOTE_CHARS: usize = 300;
/// An evidence summary, at most.
pub const EVIDENCE_CHARS: usize = 200;
/// Hooks an answer may name.
pub const HOOKS_MAX: usize = 8;
/// Words in a row an outside read and a lesson share before the lesson is
/// taken to repeat it.
pub const ECHO_WORDS: usize = 8;
/// How long a lesson that repeats outside text is kept.
pub const GUESS_VALID_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// What a model says about a neighbour it was shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Relation {
    Same,
    Opposite,
    Narrower,
    Wider,
    Unrelated,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Neighbour {
    pub id: String,
    pub relation: Relation,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AboutUser {
    pub text: String,
    #[serde(default)]
    pub category: String,
}

/// The reflection answer (its JSON schema is [`answer_schema`]).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    /// `no_lesson`, `sensitive` or `outside_text`: nothing to keep.
    #[serde(default)]
    pub skip: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub situation: String,
    #[serde(default)]
    pub wrong: String,
    #[serde(default)]
    pub instead: String,
    #[serde(default)]
    pub text: String,
    /// `routine`, `project`, `work` or `everywhere`.
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub work_kind: Option<String>,
    #[serde(default)]
    pub hooks: Vec<Cue>,
    /// Hook keys among `hooks` the note says to touch, and to stay away from.
    #[serde(default, rename = "do")]
    pub do_keys: Vec<String>,
    #[serde(default, rename = "avoid")]
    pub avoid_keys: Vec<String>,
    #[serde(default)]
    pub neighbours: Vec<Neighbour>,
    #[serde(default)]
    pub contradicts: Vec<String>,
    #[serde(default)]
    pub about_user: Option<AboutUser>,
    #[serde(default)]
    pub evidence: String,
}

/// The schema the model answers with.
pub fn answer_schema() -> Value {
    let hook_kinds: Vec<&str> = HookKind::ALL.iter().map(|k| k.as_str()).collect();
    let text = |max: usize| json!({"type": "string", "maxLength": max});
    json!({
        "type": "object",
        "properties": {
            "skip": {"type": ["string", "null"], "enum": [null, "no_lesson", "sensitive", "outside_text"]},
            "kind": {"type": "string", "enum": ["lesson", "fact", "skill"]},
            "situation": text(200),
            "wrong": text(200),
            "instead": text(200),
            "text": text(NOTE_CHARS),
            "scope": {"type": "string", "enum": ["routine", "project", "work", "everywhere"]},
            "workKind": {"type": ["string", "null"]},
            "hooks": {"type": "array", "maxItems": HOOKS_MAX, "items": {
                "type": "object",
                "properties": {"kind": {"type": "string", "enum": hook_kinds}, "key": {"type": "string"}},
                "required": ["kind", "key"]
            }},
            "do": {"type": "array", "items": {"type": "string"}},
            "avoid": {"type": "array", "items": {"type": "string"}},
            "neighbours": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "relation": {"type": "string", "enum": ["same", "opposite", "narrower", "wider", "unrelated"]}
                },
                "required": ["id", "relation"]
            }},
            "contradicts": {"type": "array", "items": {"type": "string"}},
            "aboutUser": {"type": ["object", "null"], "properties": {"text": {"type": "string"}, "category": {"type": "string"}}},
            "evidence": text(EVIDENCE_CHARS)
        },
        "required": ["skip"]
    })
}

/// What may become a note, from a model's answer or the rules.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub kind: NoteKind,
    pub text: String,
    pub situation: String,
    pub wrong: String,
    pub instead: String,
    pub trust: Trust,
    pub scope: ScopeLevel,
    pub work_kind: Option<String>,
    pub hooks: Vec<Cue>,
    pub do_keys: Vec<String>,
    pub avoid_keys: Vec<String>,
    pub evidence: String,
    /// Kept only until then: a guess from outside text.
    pub valid_for: Option<i64>,
}

/// Why an answer keeps nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skipped {
    /// The model found no lesson, or the answer was empty.
    NoLesson,
    Sensitive,
    OutsideText,
}

impl Skipped {
    pub fn as_str(self) -> &'static str {
        match self {
            Skipped::NoLesson => "no_lesson",
            Skipped::Sensitive => "sensitive",
            Skipped::OutsideText => "outside_text",
        }
    }
}

fn cut(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

/// The draft an answer gives for a moment of `trust`. `outside` are the
/// outside reads shown to the model (tool results from the web, a browser,
/// a connector, a capability, or any output of an untrusted run), `user`
/// what the user wrote around the moment.
pub fn draft_of(answer: &Answer, trust: Trust, outside: &[&str], user: &[&str]) -> Result<Draft, Skipped> {
    match answer.skip.as_deref() {
        Some("sensitive") => return Err(Skipped::Sensitive),
        Some("outside_text") => return Err(Skipped::OutsideText),
        Some(s) if !s.is_empty() => return Err(Skipped::NoLesson),
        _ => {}
    }
    let text = cut(&answer.text, NOTE_CHARS);
    if text.is_empty() {
        return Err(Skipped::NoLesson);
    }
    let kind = match answer.kind.as_deref() {
        Some("fact") => NoteKind::Fact,
        Some("skill") => NoteKind::Skill,
        _ => NoteKind::Lesson,
    };
    let scope = answer.scope.as_deref().and_then(ScopeLevel::parse).unwrap_or(ScopeLevel::Project);
    let mut hooks: Vec<Cue> = Vec::new();
    for hook in &answer.hooks {
        if !hook.key.trim().is_empty() && !hooks.contains(hook) && hooks.len() < HOOKS_MAX {
            hooks.push(Cue { kind: hook.kind, key: hook.key.trim().to_owned() });
        }
    }
    let named: HashSet<String> = hooks.iter().map(|h| h.key.clone()).collect();
    let keep = |keys: &[String]| keys.iter().filter(|k| named.contains(k.as_str())).cloned().collect::<Vec<_>>();
    let mut draft = Draft {
        kind,
        text,
        situation: cut(&answer.situation, 200),
        wrong: cut(&answer.wrong, 200),
        instead: cut(&answer.instead, 200),
        trust,
        scope,
        work_kind: answer.work_kind.clone().filter(|k| !k.is_empty()),
        hooks,
        do_keys: keep(&answer.do_keys),
        avoid_keys: keep(&answer.avoid_keys),
        evidence: cut(&answer.evidence, EVIDENCE_CHARS),
        valid_for: None,
    };
    let lesson = if draft.instead.is_empty() { draft.text.clone() } else { draft.instead.clone() };
    if echoes(&lesson, outside) && !echoes(&lesson, user) {
        draft.kind = NoteKind::Fact;
        draft.trust = Trust::Guess;
        draft.valid_for = Some(GUESS_VALID_MS);
    }
    Ok(draft)
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_owned).collect()
}

/// `text` repeats at least [`ECHO_WORDS`] words in a row of one of `sources`.
pub fn echoes(text: &str, sources: &[&str]) -> bool {
    let lesson = words(text);
    if lesson.len() < ECHO_WORDS {
        return false;
    }
    let runs: HashSet<&[String]> = lesson.windows(ECHO_WORDS).collect();
    sources.iter().any(|source| words(source).windows(ECHO_WORDS).any(|w| runs.contains(w)))
}

/// The note the rules make where no model may be asked: a rule or a
/// correction the user wrote is kept in their words; a command that worked
/// after failing becomes a skill. Other moments wait for a model, or teach
/// nothing.
pub fn template(signal: Signal, user_text: Option<&str>, cues: &[Cue]) -> Option<Draft> {
    let hooks: Vec<Cue> = cues.iter().take(HOOKS_MAX).cloned().collect();
    let base = |kind: NoteKind, text: String, trust: Trust| Draft {
        kind,
        text,
        situation: String::new(),
        wrong: String::new(),
        instead: String::new(),
        trust,
        scope: ScopeLevel::Project,
        work_kind: None,
        hooks: hooks.clone(),
        do_keys: Vec::new(),
        avoid_keys: Vec::new(),
        evidence: String::new(),
        valid_for: None,
    };
    match signal {
        Signal::StatesRule | Signal::SaysWrong => {
            let text = cut(user_text?, NOTE_CHARS);
            (!text.is_empty()).then(|| {
                let mut draft = base(NoteKind::Lesson, text.clone(), Trust::Said);
                draft.instead = cut(&text, 200);
                draft.evidence = cut(&text, EVIDENCE_CHARS);
                draft
            })
        }
        Signal::HardWon => {
            let command = cues.iter().find(|c| c.kind == HookKind::Command)?;
            let text = format!("`{}` works here after earlier attempts failed.", command.key);
            let mut draft = base(NoteKind::Skill, cut(&text, NOTE_CHARS), Trust::Outcome);
            draft.do_keys = vec![command.key.clone()];
            Some(draft)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests;
