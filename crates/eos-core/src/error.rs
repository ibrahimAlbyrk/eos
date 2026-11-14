//! What a port, a use-case or a domain rule fails with.
//!
//! The variants are the ones a caller can act on, and each has one wire
//! status (`eos-runtime` maps them, nowhere else).

/// A failure in the terms of the domain.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// 404. Reads `<resource> not found: <id>`, as today.
    #[error("{resource} not found: {id}")]
    NotFound { resource: &'static str, id: String },
    /// 409: the thing changed under the caller, or is in the wrong state.
    #[error("{0}")]
    Conflict(String),
    /// 400: the input is wrong.
    #[error("{0}")]
    Validation(String),
    /// 403.
    #[error("{0}")]
    PermissionDenied(String),
    /// 429.
    #[error("{0}")]
    LimitExceeded(String),
    /// 502: something outside the app did not answer. Reads `unreachable: <service>`.
    #[error("unreachable: {0}")]
    Unreachable(String),
    /// 400: a domain rule said no, with no narrower kind.
    #[error("{0}")]
    Rule(String),
    /// 500: an adapter failed (the database, a file). The message is for the log.
    #[error("{0}")]
    Storage(String),
}

impl Error {
    pub fn not_found(resource: &'static str, id: impl Into<String>) -> Self {
        Error::NotFound { resource, id: id.into() }
    }

    /// An adapter's own failure, kept as text: ports do not leak adapter types.
    pub fn storage(cause: impl std::fmt::Display) -> Self {
        Error::Storage(cause.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_read_as_the_typescript_errors_do() {
        assert_eq!(Error::not_found("worker", "w-1").to_string(), "worker not found: w-1");
        assert_eq!(Error::Unreachable("relay".into()).to_string(), "unreachable: relay");
        assert_eq!(Error::Conflict("stale revision".into()).to_string(), "stale revision");
        assert_eq!(Error::storage(std::io::Error::other("disk full")).to_string(), "disk full");
    }
}
