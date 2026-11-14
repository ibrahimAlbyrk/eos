use std::io;
use std::path::PathBuf;

/// What goes wrong outside an update run itself (those fail with the
/// domain's `UpdateError`): keys, building a release, the hand-over.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A key is not what its format says.
    #[error("{0}")]
    Key(String),
    /// The HTTP client could not be set up.
    #[error("http client: {0}")]
    Client(String),
    /// The release cannot be built from this input.
    #[error("{0}")]
    Release(String),
    #[error("{path}: {source}")]
    Io { path: PathBuf, source: io::Error },
}

impl Error {
    pub(crate) fn io(path: impl Into<PathBuf>) -> impl FnOnce(io::Error) -> Self {
        let path = path.into();
        move |source| Self::Io { path, source }
    }
}
