//! Errors of the machinery itself (not of a request: see `http::ApiError`).

use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// Two contributions claim the same thing; every clash is listed.
    #[error("modules conflict:\n  {}", .0.iter().map(ToString::to_string).collect::<Vec<_>>().join("\n  "))]
    Conflicts(Vec<Conflict>),
    #[error("route {route}: {reason}")]
    BadRoute { route: String, reason: &'static str },
    #[error("module {module} declares an invalid {what}: {name:?}")]
    BadDeclaration { module: String, what: &'static str, name: String },
    /// A route was registered without an access rule.
    #[error("routes without an access rule: {}", .0.join(", "))]
    UndeclaredAccess(Vec<String>),
    #[error("the ordered lane has stopped")]
    LaneStopped,
    #[error("the ordered lane's follow-up queue is full ({0} jobs): a job keeps posting jobs")]
    LaneOverrun(usize),
    #[error("a job on the ordered lane panicked: {0}")]
    JobPanicked(String),
    #[error("lifecycle: {action} is not allowed while {phase}")]
    WrongPhase { action: &'static str, phase: &'static str },
    #[error("module {module} failed to {step}: {message}")]
    Module { module: String, step: &'static str, message: String },
    #[error("shutdown did not finish within {0:?}")]
    ShutdownDeadline(Duration),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    /// "route", "topic", "job kind", "idle hook", "slash command", "settings key", "module".
    pub what: &'static str,
    pub name: String,
    pub first: String,
    pub second: String,
}

impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} {} is declared by {} and by {}", self.what, self.name, self.first, self.second)
    }
}

/// The message of a caught panic.
pub(crate) fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic".to_string()
    }
}
