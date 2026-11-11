use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// This system has no such facility; callers fall back or hide the feature.
    #[error("{0} is not supported on this system")]
    Unsupported(&'static str),
    /// A system tool ran and said no.
    #[error("{tool} failed: {detail}")]
    Tool { tool: &'static str, detail: String },
    #[error("{tool} did not finish within {} s", timeout.as_secs())]
    TimedOut { tool: &'static str, timeout: Duration },
    /// The process (group) to end is already gone.
    #[error("no process {0}")]
    NoSuchProcess(u32),
    /// The staged app must not replace the installed one. The text is shown to the user.
    #[error("{0}")]
    RejectedBundle(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
