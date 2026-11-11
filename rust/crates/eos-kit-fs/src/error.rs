use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The filesystem said no; `source.kind()` tells missing from denied from full.
    #[error("{}: {source}", path.display())]
    Io { path: PathBuf, source: io::Error },
    /// The YAML does not parse, does not fit the type asked for, or cannot be written.
    #[error("yaml: {0}")]
    Yaml(String),
}

impl Error {
    pub(crate) fn io(path: &Path) -> impl FnOnce(io::Error) -> Self + '_ {
        move |source| Self::Io { path: path.to_owned(), source }
    }

    /// The file or folder is not there.
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::Io { source, .. } if source.kind() == io::ErrorKind::NotFound)
    }
}
