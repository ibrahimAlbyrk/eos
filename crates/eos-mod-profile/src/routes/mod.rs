//! The routes: the profile's and the memories'.

pub(crate) mod memories;
pub(crate) mod profile;

use eos_runtime::http::{ApiError, Response};

use crate::Error;

/// A stale save answers 409 with the current record beside the reason.
#[derive(serde::Serialize)]
struct Stale<'a, T> {
    error: String,
    #[serde(flatten)]
    current: Current<'a, T>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum Current<'a, T> {
    Profile(&'a T),
    Memory(&'a T),
}

pub(crate) fn failed(error: Error) -> Result<Response, ApiError> {
    let reason = error.to_string();
    match &error {
        Error::StaleProfile(profile) => {
            Ok(Response::json(409, &Stale { error: reason, current: Current::Profile(profile.as_ref()) }))
        }
        Error::StaleMemory(memory) => {
            Ok(Response::json(409, &Stale { error: reason, current: Current::Memory(memory.as_ref()) }))
        }
        Error::Core(e) => Err(e.clone().into()),
    }
}
