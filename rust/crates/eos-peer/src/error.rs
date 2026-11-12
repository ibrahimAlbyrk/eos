use std::path::PathBuf;

/// What the identity and the stores can fail with. Link failures are states
/// of the link, not errors: they show in its status.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    /// The identity files exist but do not hold a certificate and its key.
    /// They are never replaced: a new identity would lose every pairing.
    #[error("the identity under {} cannot be read: {reason}", dir.display())]
    BadIdentity { dir: PathBuf, reason: String },
    #[error("a new identity could not be made: {0}")]
    KeyGeneration(String),
    #[error("the secure channel could not be set up: {0}")]
    Tls(String),
}

impl Error {
    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Self::Io { path: path.into(), source }
    }
}

impl From<eos_kit_fs::Error> for Error {
    fn from(e: eos_kit_fs::Error) -> Self {
        match e {
            eos_kit_fs::Error::Io { path, source } => Self::Io { path, source },
            other => Self::Io { path: PathBuf::new(), source: std::io::Error::other(other.to_string()) },
        }
    }
}
