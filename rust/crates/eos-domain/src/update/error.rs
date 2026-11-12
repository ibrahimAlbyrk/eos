//! Every way an update can fail, as one error type (`core/src/domain/update/errors.ts`).
//! The message is shown to the user as it is.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateErrorCode {
    /// The feed did not answer, or a server hiccup.
    Network,
    BadSignature,
    /// The release itself is unfit: malformed, or not what its pointer names.
    BadRelease,
    /// Bytes arrived or came out damaged.
    Corrupt,
    Disk,
    /// The system would not run the staged app.
    RejectedBundle,
}

impl UpdateErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::BadSignature => "bad-signature",
            Self::BadRelease => "bad-release",
            Self::Corrupt => "corrupt",
            Self::Disk => "disk",
            Self::RejectedBundle => "rejected-bundle",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateError {
    pub code: UpdateErrorCode,
    pub message: String,
}

impl UpdateError {
    pub fn new(code: UpdateErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(UpdateErrorCode::Network, message)
    }

    pub fn bad_release(message: impl Into<String>) -> Self {
        Self::new(UpdateErrorCode::BadRelease, message)
    }

    pub fn corrupt(message: impl Into<String>) -> Self {
        Self::new(UpdateErrorCode::Corrupt, message)
    }

    pub fn disk(message: impl Into<String>) -> Self {
        Self::new(UpdateErrorCode::Disk, message)
    }

    /// Worth retrying later; the rest mean the release or this install is not
    /// fit, and the same thing again would fail the same way.
    pub fn transient(&self) -> bool {
        matches!(self.code, UpdateErrorCode::Network | UpdateErrorCode::Corrupt)
    }
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UpdateError {}
