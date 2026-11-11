/// Why a fetch did not produce a body. [`code`](Error::code) is the short
/// name today's callers and the dashboard know.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// The URL, or an address it resolves or redirects to, must not be fetched.
    #[error("{0}")]
    Blocked(String),
    #[error("more than {0} redirects")]
    Redirects(usize),
    #[error("no answer within {0} s")]
    Timeout(u64),
    #[error("{0}")]
    TooLarge(String),
    /// The content type is not one the caller asked for.
    #[error("{0} is not what was asked for")]
    Type(String),
    #[error("the server answered {0}")]
    Status(u16),
    #[error("{0}")]
    Network(String),
    /// The HTTP client itself could not be set up.
    #[error("http client: {0}")]
    Client(String),
}

impl Error {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Blocked(_) => "blocked",
            Self::Redirects(_) => "redirects",
            Self::Timeout(_) => "timeout",
            Self::TooLarge(_) => "too-large",
            Self::Type(_) => "type",
            Self::Status(_) => "status",
            Self::Network(_) | Self::Client(_) => "network",
        }
    }

    /// The HTTP status, for [`Error::Status`].
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Status(status) => Some(*status),
            _ => None,
        }
    }
}
