//! The Forge (06 G9): what an agent asks of it (`request_capability`,
//! `forge_report`) and the dashboard's `POST /api/forge`, implemented by
//! `eos-mod-forge`.

use serde_json::Value;

use crate::{BoxFuture, Error};

/// Who asks the Forge for a capability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeCaller {
    /// The user, from the dashboard.
    User,
    /// An agent, through `request_capability`.
    Agent { worker_id: String },
}

/// A need the Forge is asked to meet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeRequest {
    pub need: String,
    /// The routine that waits for it.
    pub routine_id: Option<String>,
    /// The capability to repair or update.
    pub capability_id: Option<String>,
    /// The App to promote.
    pub from_surface: Option<String>,
    pub caller: ForgeCaller,
}

/// What a request came to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeAnswer {
    /// A Forge run started: it researches first, then asks the user.
    Started { run_id: String },
    /// The capability exists and works already.
    Ready { capability_id: String },
    /// The capability exists; the user takes `step` to make it work.
    Setup { capability_id: String, step: String },
}

/// The stage a Forge session reports on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeStage {
    Research,
    Build,
    Review,
}

impl ForgeStage {
    pub fn as_str(self) -> &'static str {
        match self {
            ForgeStage::Research => "research",
            ForgeStage::Build => "build",
            ForgeStage::Review => "review",
        }
    }

    pub fn parse(word: &str) -> Option<ForgeStage> {
        [ForgeStage::Research, ForgeStage::Build, ForgeStage::Review].into_iter().find(|stage| stage.as_str() == word)
    }
}

pub trait Forge: Send + Sync {
    /// Starts a Forge run for the need, or answers the capability that
    /// meets it already.
    fn request(&self, request: ForgeRequest) -> BoxFuture<'_, Result<ForgeAnswer, Error>>;
    /// Keeps the report a Forge session hands in for its stage; refused
    /// for a session of another stage, or a report of the wrong shape.
    fn report<'a>(&'a self, worker_id: &'a str, stage: ForgeStage, report: Value) -> BoxFuture<'a, Result<(), Error>>;
}
