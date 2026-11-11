//! The one place a failure becomes a status code and an error body.

use std::borrow::Cow;
use std::io;

use super::response::{ErrorBody, Response};
use crate::access::Refusal;

/// A request that failed, in the terms a caller can act on. Each variant maps
/// to today's status code and `{ "error": … }` body.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ApiError {
    /// 404.
    #[error("{0}")]
    NotFound(String),
    /// 409.
    #[error("{0}")]
    Conflict(String),
    /// 400: the request itself is wrong.
    #[error("{0}")]
    Validation(String),
    /// 403.
    #[error("{0}")]
    PermissionDenied(String),
    /// 429.
    #[error("{0}")]
    LimitExceeded(String),
    /// 502: something outside the app did not answer.
    #[error("{0}")]
    Unreachable(String),
    /// 400: a domain rule said no.
    #[error("{0}")]
    Domain(String),
    /// 413, with the limit in the body.
    #[error("request body too large (limit {limit} bytes)")]
    BodyTooLarge { limit: usize },
    /// 503: the process ran out of file descriptors.
    #[error("the app ran out of file descriptors — reduce concurrent workers or restart Eos")]
    OutOfDescriptors { code: &'static str },
    /// Any other status with an `error` message and an optional `code`.
    #[error("{message}")]
    Status { status: u16, message: String, code: Option<Cow<'static, str>> },
    /// 500: a failure nobody classified.
    #[error("{0}")]
    Internal(String),
}

impl ApiError {
    pub fn status(&self) -> u16 {
        match self {
            ApiError::NotFound(_) => 404,
            ApiError::Conflict(_) => 409,
            ApiError::Validation(_) | ApiError::Domain(_) => 400,
            ApiError::PermissionDenied(_) => 403,
            ApiError::LimitExceeded(_) => 429,
            ApiError::Unreachable(_) => 502,
            ApiError::BodyTooLarge { .. } => 413,
            ApiError::OutOfDescriptors { .. } => 503,
            ApiError::Status { status, .. } => *status,
            ApiError::Internal(_) => 500,
        }
    }

    pub fn status_with(status: u16, message: impl Into<String>) -> Self {
        ApiError::Status { status, message: message.into(), code: None }
    }

    pub fn coded(status: u16, message: impl Into<String>, code: impl Into<Cow<'static, str>>) -> Self {
        ApiError::Status { status, message: message.into(), code: Some(code.into()) }
    }

    /// A failed validation as today's body: `invalid request: <path>: <message>; …`.
    pub fn invalid<P: AsRef<str>, M: AsRef<str>>(issues: impl IntoIterator<Item = (P, M)>) -> Self {
        let flat: Vec<String> = issues.into_iter().map(|(p, m)| format!("{}: {}", p.as_ref(), m.as_ref())).collect();
        ApiError::Validation(format!("invalid request: {}", flat.join("; ")))
    }

    /// An I/O failure: descriptor exhaustion gets its own answer, the rest is a 500.
    pub fn io(e: &io::Error) -> Self {
        // EBADF on a spawn or open under load is the same exhaustion showing
        // up on whichever call lost the race for the last descriptor.
        let code = match e.raw_os_error() {
            Some(9) => Some("EBADF"),
            Some(23) => Some("ENFILE"),
            Some(24) => Some("EMFILE"),
            _ => None,
        };
        match code {
            Some(code) => ApiError::OutOfDescriptors { code },
            None => ApiError::Internal(e.to_string()),
        }
    }

    pub fn into_response(self) -> Response {
        let status = self.status();
        let message = self.to_string();
        let mut body = ErrorBody { error: &message, ..ErrorBody::default() };
        match &self {
            ApiError::BodyTooLarge { limit } => body.limit = Some(*limit),
            ApiError::OutOfDescriptors { code } => body.code = Some(code),
            ApiError::Status { code: Some(code), .. } => body.code = Some(code),
            _ => {}
        }
        Response::json(status, &body)
    }
}

/// A failed contract check: 400 with Zod's wording.
impl From<eos_contracts::ValidationError> for ApiError {
    fn from(e: eos_contracts::ValidationError) -> Self {
        ApiError::Validation(e.message())
    }
}

/// A port's or a use-case's failure, as `manager/middleware/errorHandler.ts` mapped it.
impl From<eos_core::Error> for ApiError {
    fn from(e: eos_core::Error) -> Self {
        use eos_core::Error;
        let message = e.to_string();
        match e {
            Error::NotFound { .. } => ApiError::NotFound(message),
            Error::Conflict(_) => ApiError::Conflict(message),
            Error::Validation(_) => ApiError::Validation(message),
            Error::PermissionDenied(_) => ApiError::PermissionDenied(message),
            Error::LimitExceeded(_) => ApiError::LimitExceeded(message),
            Error::Unreachable(_) => ApiError::Unreachable(message),
            Error::Rule(_) => ApiError::Domain(message),
            Error::Storage(_) => ApiError::Internal(message),
        }
    }
}

/// What a turned-away caller reads. Paired computers and local pages get
/// today's bodies; the phone gateway reads [`Response::refusal`] and answers
/// in its own frames.
pub(crate) fn refusal_response(refusal: Refusal, path: &str) -> Response {
    let (error, code, path) = match refusal {
        Refusal::LocalOnly => ("not available from another device", None, Some(path)),
        Refusal::NeedsHuman => ("only the Eos window can do this on another computer", Some("needs-human"), Some(path)),
        Refusal::UiToken => ("ui token required", None, None),
        Refusal::PhoneRefused => ("route not exposed remotely", Some("ROUTE_REFUSED"), None),
        Refusal::PhoneCapability => ("device lacks the mutate capability", Some("CAP_DENIED"), None),
        Refusal::PhoneTier => ("device may not call routes of this tier", Some("CAP_DENIED"), None),
        Refusal::Undeclared => ("route has no access rule", None, Some(path)),
    };
    Response::json(403, &ErrorBody { error, code, path, limit: None }).refused(refusal)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body(e: ApiError) -> (u16, String) {
        let res = e.into_response();
        let bytes = res.body.collect().await.expect("in memory");
        (res.status, String::from_utf8(bytes.to_vec()).expect("utf-8"))
    }

    #[tokio::test]
    async fn maps_each_failure_to_todays_status_and_body() {
        assert_eq!(
            body(ApiError::NotFound("worker not found".into())).await,
            (404, r#"{"error":"worker not found"}"#.into())
        );
        assert_eq!(body(ApiError::Conflict("stale".into())).await.0, 409);
        assert_eq!(body(ApiError::Validation("bad".into())).await.0, 400);
        assert_eq!(body(ApiError::Domain("no".into())).await.0, 400);
        assert_eq!(body(ApiError::PermissionDenied("no".into())).await.0, 403);
        assert_eq!(body(ApiError::LimitExceeded("slow down".into())).await.0, 429);
        assert_eq!(body(ApiError::Unreachable("relay".into())).await.0, 502);
        assert_eq!(body(ApiError::Internal("boom".into())).await, (500, r#"{"error":"boom"}"#.into()));
        assert_eq!(
            body(ApiError::BodyTooLarge { limit: 1_048_576 }).await,
            (413, r#"{"error":"request body too large (limit 1048576 bytes)","limit":1048576}"#.into())
        );
        assert_eq!(
            body(ApiError::coded(404, "Pages is turned off (Settings › Plugins)", "plugin_off")).await,
            (404, r#"{"error":"Pages is turned off (Settings › Plugins)","code":"plugin_off"}"#.into())
        );
        assert_eq!(body(ApiError::status_with(410, "gone")).await, (410, r#"{"error":"gone"}"#.into()));
    }

    #[tokio::test]
    async fn names_descriptor_exhaustion() {
        let (status, text) = body(ApiError::io(&io::Error::from_raw_os_error(24))).await;
        assert_eq!(status, 503);
        assert!(text.starts_with(r#"{"error":"the app ran out"#) && text.ends_with(r#""code":"EMFILE"}"#), "{text}");
        assert_eq!(ApiError::io(&io::Error::other("disk")).status(), 500);
    }

    #[test]
    fn maps_port_failures() {
        use eos_core::Error;
        let cases = [
            (Error::not_found("worker", "w-1"), 404, "worker not found: w-1"),
            (Error::Conflict("stale".into()), 409, "stale"),
            (Error::Validation("bad".into()), 400, "bad"),
            (
                Error::PermissionDenied("worker w-2 is not managed by o-1".into()),
                403,
                "worker w-2 is not managed by o-1",
            ),
            (Error::LimitExceeded("slow down".into()), 429, "slow down"),
            (Error::Unreachable("relay".into()), 502, "unreachable: relay"),
            (Error::Rule("no".into()), 400, "no"),
            (Error::Storage("disk".into()), 500, "disk"),
        ];
        for (error, status, message) in cases {
            let api = ApiError::from(error);
            assert_eq!((api.status(), api.to_string().as_str()), (status, message));
        }
    }

    #[test]
    fn formats_validation_issues() {
        let e = ApiError::invalid([("clientId", "Required"), ("workers", "Expected array, received string")]);
        assert_eq!(e.to_string(), "invalid request: clientId: Required; workers: Expected array, received string");
    }
}
