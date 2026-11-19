//! Where a capability stands, why, and what each thing Eos notices does to
//! it. A capability that works is `ready`; one that is slow or limited is
//! `degraded` and still called; one that needs the user or is broken is
//! refused, and the routines that use it wait. Pure: the service applies
//! what it saw with [`Health::after`] and keeps the result.

/// Failures in a row that break a capability.
pub const FAILURES_TO_BREAK: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HealthState {
    Ready,
    /// Rate-limited, or the service failed or timed out: still called.
    Degraded,
    NeedsSignIn,
    /// A secret, setting, program or permission is missing.
    NeedsSetup,
    Broken,
    /// Switched off by the user.
    Disabled,
    /// Known from another computer of the user, not installed on this one.
    Available,
}

impl HealthState {
    pub const ALL: [HealthState; 7] = [
        HealthState::Ready,
        HealthState::Degraded,
        HealthState::NeedsSignIn,
        HealthState::NeedsSetup,
        HealthState::Broken,
        HealthState::Disabled,
        HealthState::Available,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            HealthState::Ready => "ready",
            HealthState::Degraded => "degraded",
            HealthState::NeedsSignIn => "needs_sign_in",
            HealthState::NeedsSetup => "needs_setup",
            HealthState::Broken => "broken",
            HealthState::Disabled => "disabled",
            HealthState::Available => "available",
        }
    }

    /// A stored state; `None` for a word this version does not know.
    pub fn parse(text: &str) -> Option<HealthState> {
        HealthState::ALL.into_iter().find(|state| state.as_str() == text)
    }

    /// Whether its actions may be called.
    pub fn takes_calls(self) -> bool {
        matches!(self, HealthState::Ready | HealthState::Degraded)
    }
}

/// Why a capability is in its state, as the user is told.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum StateCode {
    /// The secret of this name was never entered.
    SecretMissing(String),
    /// GitHub's sign-in has no client id.
    ClientIdMissing,
    /// macOS refused the Apple Events it needs.
    AutomationDenied,
    Http401,
    /// The package's files changed since it was installed.
    HashMismatch,
    ProgramMissing,
    SandboxUnavailable,
    RateLimited,
    HealthFailed,
    /// Its output broke the schema it declares: the service changed.
    OutputSchema,
}

impl StateCode {
    pub fn as_string(&self) -> String {
        match self {
            StateCode::SecretMissing(name) => format!("secret_missing:{name}"),
            StateCode::ClientIdMissing => "client_id_missing".to_owned(),
            StateCode::AutomationDenied => "automation_denied".to_owned(),
            StateCode::Http401 => "http_401".to_owned(),
            StateCode::HashMismatch => "hash_mismatch".to_owned(),
            StateCode::ProgramMissing => "program_missing".to_owned(),
            StateCode::SandboxUnavailable => "sandbox_unavailable".to_owned(),
            StateCode::RateLimited => "rate_limited".to_owned(),
            StateCode::HealthFailed => "health_failed".to_owned(),
            StateCode::OutputSchema => "output_schema".to_owned(),
        }
    }

    /// A stored code; `None` for one this version does not know.
    pub fn parse(text: &str) -> Option<StateCode> {
        if let Some(name) = text.strip_prefix("secret_missing:") {
            return (!name.is_empty()).then(|| StateCode::SecretMissing(name.to_owned()));
        }
        [
            StateCode::ClientIdMissing,
            StateCode::AutomationDenied,
            StateCode::Http401,
            StateCode::HashMismatch,
            StateCode::ProgramMissing,
            StateCode::SandboxUnavailable,
            StateCode::RateLimited,
            StateCode::HealthFailed,
            StateCode::OutputSchema,
        ]
        .into_iter()
        .find(|code| code.as_string() == text)
    }
}

/// What Eos noticed about a capability: from its health check, a call, or
/// the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A health check passed.
    Passed,
    /// A call worked and its output fit.
    Worked,
    /// The service limited the rate.
    RateLimited,
    /// A call failed with a server error or timed out.
    CallFailed,
    /// A health check failed for a reason of its own.
    CheckFailed,
    /// The service refused the sign-in (401, a revoked token).
    Unauthorized,
    /// A step the user takes is missing: one of the setup codes
    /// (`secret_missing`, `client_id_missing`, `automation_denied`,
    /// `program_missing`).
    Missing(StateCode),
    HashMismatch,
    SandboxUnavailable,
    /// A call's output broke its schema.
    BadOutput,
    /// The user switched it off.
    Disabled,
}

/// What `capability_installs` keeps of a capability's health.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
    pub state: HealthState,
    pub code: Option<StateCode>,
    /// Failed checks and broken outputs in a row.
    pub failures: u32,
}

impl Health {
    pub fn ready() -> Health {
        Health { state: HealthState::Ready, code: None, failures: 0 }
    }

    /// Installed or switched on again: it stands where its first check puts
    /// it.
    pub fn fresh(check: Event) -> Health {
        Health::ready().after(check)
    }

    /// The health once `event` happened. A capability switched off, or not
    /// installed here, changes only by the user's hand ([`Health::fresh`]);
    /// one that is refused leaves its state only when a check passes or
    /// another refusal takes its place. Outputs that broke their schema stop
    /// counting only when a call's output fits. A pass ends `hash_mismatch`
    /// too, so a package's check counts as [`Event::Passed`] only once its
    /// files hashed to the pinned hash again: its code runs only after that
    /// hash.
    pub fn after(&self, event: Event) -> Health {
        if matches!(self.state, HealthState::Disabled | HealthState::Available) {
            return self.clone();
        }
        let set = |state, code| Health { state, code, failures: self.failures };
        let called = self.state.takes_calls();
        match event {
            // A check does not look at outputs, so it keeps their count. A ready
            // capability counts nothing else: a failed check degrades it.
            Event::Passed if self.state == HealthState::Ready => self.clone(),
            Event::Passed | Event::Worked => Health::ready(),
            Event::RateLimited if called => set(HealthState::Degraded, Some(StateCode::RateLimited)),
            Event::CallFailed if called => set(HealthState::Degraded, None),
            Event::RateLimited | Event::CallFailed => self.clone(),
            Event::CheckFailed => self.failed(StateCode::HealthFailed, true),
            Event::BadOutput => self.failed(StateCode::OutputSchema, false),
            Event::Unauthorized => set(HealthState::NeedsSignIn, Some(StateCode::Http401)),
            Event::Missing(code) => set(HealthState::NeedsSetup, Some(code)),
            Event::HashMismatch => set(HealthState::Broken, Some(StateCode::HashMismatch)),
            Event::SandboxUnavailable => set(HealthState::Broken, Some(StateCode::SandboxUnavailable)),
            Event::Disabled => Health { state: HealthState::Disabled, code: None, failures: 0 },
        }
    }

    /// One more failure in a row. A capability still called breaks at
    /// [`FAILURES_TO_BREAK`]; below it a failed check degrades it.
    fn failed(&self, code: StateCode, degrades: bool) -> Health {
        let failures = self.failures + 1;
        if !self.state.takes_calls() {
            return Health { failures, ..self.clone() };
        }
        if failures >= FAILURES_TO_BREAK {
            return Health { state: HealthState::Broken, code: Some(code), failures };
        }
        if degrades {
            return Health { state: HealthState::Degraded, code: Some(code), failures };
        }
        Health { failures, ..self.clone() }
    }
}

#[cfg(test)]
mod tests;
