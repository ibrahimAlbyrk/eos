//! Signing in to a capability by a code (GitHub's device flow):
//! `POST /api/capabilities/:id/sign-in` asks the service for a code and
//! starts polling for the user's answer, `GET` answers how the attempt
//! stands, `DELETE` ends it. One attempt per capability; a new one ends the
//! one before. Once signed in, the token is kept, the account's label too,
//! and the capability is checked, which announces it ready on
//! `capabilities:change`.
//!
//! The codes and the token never reach a log, an error or a frame; the
//! label is shown to the dashboard only.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_capabilities::CapabilityService;
use eos_contracts::{CapabilitySignIn, CapabilitySignInState, CapabilitySignInStatus};
use eos_core::Error;
use eos_core::capability::{BuiltinCapability, CapabilityRegistry, SignInError};
use eos_runtime::http::ApiError;
use tokio::task::AbortHandle;

/// One attempt and the task that polls for it.
struct Attempt {
    /// Tells this attempt from a later one of the same capability.
    serial: u64,
    status: CapabilitySignInStatus,
    task: Option<AbortHandle>,
}

/// The attempts under way or ended, by capability.
#[derive(Default)]
pub(crate) struct SignIns {
    attempts: Mutex<HashMap<String, Attempt>>,
    serial: Mutex<u64>,
}

fn status(state: CapabilitySignInState) -> CapabilitySignInStatus {
    CapabilitySignInStatus { state, account_label: None }
}

impl SignIns {
    fn attempts(&self) -> MutexGuard<'_, HashMap<String, Attempt>> {
        self.attempts.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The built-in `id` when it signs in by a code, or 404.
    fn builtin(service: &CapabilityService, id: &str) -> Result<Arc<dyn BuiltinCapability>, Error> {
        service.signs_in_by_code(id).ok_or_else(|| Error::not_found("capability sign-in", id))
    }

    pub(crate) async fn start(
        self: &Arc<Self>,
        service: &Arc<CapabilityService>,
        id: &str,
    ) -> Result<CapabilitySignIn, ApiError> {
        let builtin = Self::builtin(service, id)?;
        let Some(flow) = builtin.device_sign_in() else {
            return Err(Error::not_found("capability sign-in", id).into());
        };
        let code = match flow.start().await {
            Ok(code) => code,
            Err(SignInError::ClientIdMissing) => {
                let name = service.get(id).await?.map_or_else(|| id.to_owned(), |capability| capability.manifest.name);
                let message = format!("{name} has no client id to sign in with");
                return Err(ApiError::coded(409, message, "client_id_missing"));
            }
            Err(SignInError::RateLimited) => {
                return Err(Error::LimitExceeded(format!("{id} is limiting requests")).into());
            }
            Err(_) => return Err(Error::Unreachable(id.to_owned()).into()),
        };
        let answer = CapabilitySignIn {
            user_code: code.user_code.to_string(),
            verification_uri: code.verification_uri.clone(),
            expires_at: code.expires_at,
        };
        let serial = {
            let mut serial = self.serial.lock().unwrap_or_else(|p| p.into_inner());
            *serial += 1;
            *serial
        };
        let mut attempts = self.attempts();
        let pending = Attempt { serial, status: status(CapabilitySignInState::Pending), task: None };
        if let Some(Attempt { task: Some(previous), .. }) = attempts.insert(id.to_owned(), pending) {
            previous.abort();
        }
        let (me, service, owned) = (self.clone(), service.clone(), id.to_owned());
        let task = tokio::spawn(async move {
            let Some(flow) = builtin.device_sign_in() else { return };
            let ended = match flow.finish(&code).await {
                Ok(label) => match service.signed_in(&owned, label.clone()).await {
                    Ok(_) => {
                        CapabilitySignInStatus { state: CapabilitySignInState::SignedIn, account_label: Some(label) }
                    }
                    Err(e) => {
                        tracing::warn!(capability = %owned, error = %e, "a sign-in could not be kept");
                        status(CapabilitySignInState::Failed)
                    }
                },
                Err(SignInError::Expired) => status(CapabilitySignInState::Expired),
                Err(SignInError::Denied) => status(CapabilitySignInState::Denied),
                Err(_) => status(CapabilitySignInState::Failed),
            };
            tracing::info!(capability = %owned, state = ?ended.state, "a capability sign-in ended");
            if let Some(attempt) = me.attempts().get_mut(&owned).filter(|attempt| attempt.serial == serial) {
                attempt.status = ended;
                attempt.task = None;
            }
        });
        if let Some(attempt) = attempts.get_mut(id).filter(|attempt| attempt.serial == serial) {
            attempt.task = Some(task.abort_handle());
        }
        Ok(answer)
    }

    /// How the capability's attempt stands; 404 when there is none.
    pub(crate) fn status(&self, service: &CapabilityService, id: &str) -> Result<CapabilitySignInStatus, Error> {
        Self::builtin(service, id)?;
        let attempts = self.attempts();
        attempts.get(id).map(|attempt| attempt.status.clone()).ok_or_else(|| Error::not_found("capability sign-in", id))
    }

    /// Ends the capability's attempt; one already ended is forgotten.
    pub(crate) fn cancel(&self, service: &CapabilityService, id: &str) -> Result<(), Error> {
        Self::builtin(service, id)?;
        if let Some(Attempt { task: Some(task), .. }) = self.attempts().remove(id) {
            task.abort();
        }
        Ok(())
    }

    /// Ends every attempt: the app stops.
    pub(crate) fn stop(&self) {
        for (_, attempt) in self.attempts().drain() {
            if let Some(task) = attempt.task {
                task.abort();
            }
        }
    }
}
