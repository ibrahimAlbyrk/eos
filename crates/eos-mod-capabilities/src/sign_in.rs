//! Signing in to a capability: by a code the user enters on the service's
//! page (GitHub's device flow), or in the browser with a link back
//! (Slack's PKCE). `POST /api/capabilities/:id/sign-in` starts an attempt,
//! `GET` answers how it stands, `DELETE` ends it. One attempt per
//! capability; a new one ends the one before. A device attempt polls for
//! the user's answer; a browser attempt waits for its `eos://sign-in/<id>`
//! link, which the shell hands here and never to the dashboard, and a link
//! whose `state` matches no live attempt is dropped. Once signed in, the
//! token is kept, the account's label too, and the capability is checked,
//! which announces it ready on `capabilities:change`.
//!
//! The codes, the state, the verifier and the token never reach a log, an
//! error or a frame; the label is shown to the dashboard only.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_capabilities::CapabilityService;
use eos_contracts::{CapabilitySignIn, CapabilitySignInState, CapabilitySignInStatus};
use eos_core::capability::{BrowserCallback, BrowserCode, BuiltinCapability, CapabilityRegistry, SignInError};
use eos_core::{Clock, Error};
use eos_runtime::http::ApiError;
use tokio::task::AbortHandle;
use zeroize::Zeroizing;

/// The prefix of a sign-in's link back.
pub const SIGN_IN_LINK: &str = "eos://sign-in/";

/// A browser attempt's secrets, until its link comes back.
struct Waiting {
    builtin: Arc<dyn BuiltinCapability>,
    code: BrowserCode,
}

/// One attempt, and the task that finishes it.
struct Attempt {
    /// Tells this attempt from a later one of the same capability.
    serial: u64,
    status: CapabilitySignInStatus,
    task: Option<AbortHandle>,
    waiting: Option<Waiting>,
}

/// The attempts under way or ended, by capability.
pub(crate) struct SignIns {
    clock: Arc<dyn Clock>,
    attempts: Mutex<HashMap<String, Attempt>>,
    serial: Mutex<u64>,
}

fn status(state: CapabilitySignInState) -> CapabilitySignInStatus {
    CapabilitySignInStatus { state, account_label: None }
}

/// A sign-in that ended: signed in with its label kept, or how it failed.
async fn ended(service: &CapabilityService, id: &str, result: Result<String, SignInError>) -> CapabilitySignInStatus {
    let ended = match result {
        Ok(label) => match service.signed_in(id, label.clone()).await {
            Ok(_) => CapabilitySignInStatus { state: CapabilitySignInState::SignedIn, account_label: Some(label) },
            Err(e) => {
                tracing::warn!(capability = %id, error = %e, "a sign-in could not be kept");
                status(CapabilitySignInState::Failed)
            }
        },
        Err(SignInError::Expired) => status(CapabilitySignInState::Expired),
        Err(SignInError::Denied) => status(CapabilitySignInState::Denied),
        Err(_) => status(CapabilitySignInState::Failed),
    };
    tracing::info!(capability = %id, state = ?ended.state, "a capability sign-in ended");
    ended
}

/// Why a sign-in did not start, as its route answers.
async fn refused(service: &CapabilityService, id: &str, error: SignInError) -> ApiError {
    match error {
        SignInError::ClientIdMissing => {
            let found = service.get(id).await.ok().flatten();
            let name = found.map_or_else(|| id.to_owned(), |capability| capability.manifest.name);
            ApiError::coded(409, format!("{name} has no client id to sign in with"), "client_id_missing")
        }
        SignInError::RateLimited => Error::LimitExceeded(format!("{id} is limiting requests")).into(),
        _ => Error::Unreachable(id.to_owned()).into(),
    }
}

/// The capability, callback and state an `eos://sign-in/<id>?…` link carries.
fn read_link(link: &str) -> Option<(String, BrowserCallback, Zeroizing<String>)> {
    let rest = link.strip_prefix(SIGN_IN_LINK)?;
    let (id, query) = rest.split_once('?').unwrap_or((rest, ""));
    let fields: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes()).into_owned().collect();
    let state = Zeroizing::new(fields.get("state")?.clone());
    let callback = match (fields.get("code"), fields.get("error")) {
        (Some(code), _) if !code.is_empty() => BrowserCallback::Code(Zeroizing::new(code.clone())),
        (_, Some(error)) => BrowserCallback::Refused(error.clone()),
        _ => return None,
    };
    Some((id.trim_end_matches('/').to_owned(), callback, state))
}

impl SignIns {
    pub(crate) fn new(clock: Arc<dyn Clock>) -> Self {
        Self { clock, attempts: Mutex::default(), serial: Mutex::default() }
    }

    fn attempts(&self) -> MutexGuard<'_, HashMap<String, Attempt>> {
        self.attempts.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The built-in `id` when it signs in at all, or 404.
    fn builtin(service: &CapabilityService, id: &str) -> Result<Arc<dyn BuiltinCapability>, Error> {
        service.signs_in(id).ok_or_else(|| Error::not_found("capability sign-in", id))
    }

    /// Records a new attempt in place of the one before; its serial.
    fn begin(&self, id: &str, waiting: Option<Waiting>) -> u64 {
        let serial = {
            let mut serial = self.serial.lock().unwrap_or_else(|p| p.into_inner());
            *serial += 1;
            *serial
        };
        let pending = Attempt { serial, status: status(CapabilitySignInState::Pending), task: None, waiting };
        if let Some(Attempt { task: Some(previous), .. }) = self.attempts().insert(id.to_owned(), pending) {
            previous.abort();
        }
        serial
    }

    fn settle(&self, id: &str, serial: u64, done: CapabilitySignInStatus) {
        if let Some(attempt) = self.attempts().get_mut(id).filter(|attempt| attempt.serial == serial) {
            attempt.status = done;
            attempt.task = None;
        }
    }

    fn keep_task(&self, id: &str, serial: u64, task: AbortHandle) {
        if let Some(attempt) = self.attempts().get_mut(id).filter(|attempt| attempt.serial == serial) {
            attempt.task = Some(task);
        }
    }

    pub(crate) async fn start(
        self: &Arc<Self>,
        service: &Arc<CapabilityService>,
        id: &str,
    ) -> Result<CapabilitySignIn, ApiError> {
        let builtin = Self::builtin(service, id)?;
        if let Some(flow) = builtin.browser_sign_in() {
            let code = match flow.start().await {
                Ok(code) => code,
                Err(error) => return Err(refused(service, id, error).await),
            };
            let (verification_uri, expires_at) = (code.authorize_uri.clone(), code.expires_at);
            self.begin(id, Some(Waiting { builtin: builtin.clone(), code }));
            return Ok(CapabilitySignIn { user_code: None, verification_uri, expires_at });
        }
        let Some(flow) = builtin.device_sign_in() else {
            return Err(Error::not_found("capability sign-in", id).into());
        };
        let code = match flow.start().await {
            Ok(code) => code,
            Err(error) => return Err(refused(service, id, error).await),
        };
        let answer = CapabilitySignIn {
            user_code: Some(code.user_code.to_string()),
            verification_uri: code.verification_uri.clone(),
            expires_at: code.expires_at,
        };
        let serial = self.begin(id, None);
        let (me, service, owned) = (self.clone(), service.clone(), id.to_owned());
        let task = tokio::spawn(async move {
            let Some(flow) = builtin.device_sign_in() else { return };
            let done = ended(&service, &owned, flow.finish(&code).await).await;
            me.settle(&owned, serial, done);
        });
        self.keep_task(id, serial, task.abort_handle());
        Ok(answer)
    }

    /// Takes an `eos://sign-in/<id>` link: the attempt whose state it names
    /// finishes. Whether it was one.
    pub(crate) fn link(self: &Arc<Self>, service: &Arc<CapabilityService>, link: &str) -> bool {
        let Some((id, callback, state)) = read_link(link) else {
            tracing::info!("a sign-in link that names no attempt was dropped");
            return false;
        };
        let (serial, waiting) = {
            let mut attempts = self.attempts();
            let live = attempts.get_mut(&id).filter(|attempt| {
                attempt.waiting.as_ref().is_some_and(|waiting| {
                    waiting.code.state.as_str() == state.as_str() && waiting.code.expires_at > self.clock.now_ms()
                })
            });
            let Some(attempt) = live else {
                tracing::info!(capability = %id, "a sign-in link that matches no attempt was dropped");
                return false;
            };
            (attempt.serial, attempt.waiting.take())
        };
        let Some(Waiting { builtin, code }) = waiting else { return false };
        let (me, service, owned) = (self.clone(), service.clone(), id.clone());
        let task = tokio::spawn(async move {
            let Some(flow) = builtin.browser_sign_in() else { return };
            let done = ended(&service, &owned, flow.finish(&code, callback).await).await;
            me.settle(&owned, serial, done);
        });
        self.keep_task(&id, serial, task.abort_handle());
        true
    }

    /// How the capability's attempt stands; 404 when there is none. A
    /// browser attempt whose link never came ends when its time is up.
    pub(crate) fn status(&self, service: &CapabilityService, id: &str) -> Result<CapabilitySignInStatus, Error> {
        Self::builtin(service, id)?;
        let now = self.clock.now_ms();
        let mut attempts = self.attempts();
        let attempt = attempts.get_mut(id).ok_or_else(|| Error::not_found("capability sign-in", id))?;
        if attempt.waiting.as_ref().is_some_and(|waiting| waiting.code.expires_at <= now) {
            attempt.waiting = None;
            attempt.status = status(CapabilitySignInState::Expired);
        }
        Ok(attempt.status.clone())
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
