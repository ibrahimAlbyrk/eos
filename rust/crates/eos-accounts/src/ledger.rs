//! Which plan sign-ins cannot run right now, kept in memory
//! (`core/src/services/PlanLimitLedger.ts`). A plan limit lifts by itself at
//! its reset time; a sign-in that stopped working stays out until it is
//! signed in again. New sessions and account switches skip what is listed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use eos_core::Clock;
use eos_domain::accounts::{LoginReadiness, PlanLimitMark, PlanLimitReason, readiness};

/// At most one mark per sign-in; a mark goes when its limit lifts, when the
/// sign-in is signed in again and when it is removed.
pub struct PlanLimitLedger {
    clock: Arc<dyn Clock>,
    marks: Mutex<HashMap<String, PlanLimitMark>>,
}

impl std::fmt::Debug for PlanLimitLedger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlanLimitLedger").finish_non_exhaustive()
    }
}

impl PlanLimitLedger {
    pub fn new(clock: Arc<dyn Clock>) -> Self {
        Self { clock, marks: Mutex::default() }
    }

    fn marks(&self) -> MutexGuard<'_, HashMap<String, PlanLimitMark>> {
        self.marks.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// `until`: when the limit lifts (epoch ms), if the provider said.
    pub fn mark(&self, login_id: &str, reason: PlanLimitReason, until: Option<i64>) {
        let mark = PlanLimitMark::new(reason, until, self.clock.now_ms());
        self.marks().insert(login_id.to_owned(), mark);
    }

    pub fn clear(&self, login_id: &str) {
        self.marks().remove(login_id);
    }

    /// The sign-in's mark, unless its limit has lifted.
    pub fn blocked(&self, login_id: &str) -> Option<PlanLimitMark> {
        let mut marks = self.marks();
        let mark = *marks.get(login_id)?;
        if mark.lifted(self.clock.now_ms()) {
            marks.remove(login_id);
            return None;
        }
        Some(mark)
    }

    pub fn readiness(&self, login_id: &str, signed_in: bool) -> LoginReadiness {
        readiness(self.blocked(login_id).as_ref(), signed_in)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use eos_testkit::FakeClock;

    // core/src/__tests__/SwitchSessionAccount.test.ts, "PlanLimitLedger"
    #[test]
    fn a_limit_lifts_at_its_reset_and_one_without_a_reset_after_an_hour() {
        let clock = Arc::new(FakeClock::at(1_000));
        let ledger = PlanLimitLedger::new(clock.clone());
        ledger.mark("a", PlanLimitReason::Limit, Some(5_000));
        ledger.mark("b", PlanLimitReason::Limit, None);
        assert_eq!(ledger.readiness("a", true), LoginReadiness::Limited);
        clock.set(5_000);
        assert_eq!(ledger.blocked("a"), None);
        assert_eq!(ledger.readiness("a", true), LoginReadiness::Ready);
        assert_eq!(ledger.blocked("b").and_then(|m| m.until), Some(1_000 + 60 * 60_000));
        clock.set(1_000 + 60 * 60_000);
        assert_eq!(ledger.readiness("b", true), LoginReadiness::Ready);
    }

    #[test]
    fn a_sign_in_that_stopped_working_stays_out_until_cleared() {
        let clock = Arc::new(FakeClock::at(1_000));
        let ledger = PlanLimitLedger::new(clock.clone());
        ledger.mark("a", PlanLimitReason::Expired, Some(2_000));
        clock.set(i64::MAX / 2);
        assert_eq!(ledger.readiness("a", true), LoginReadiness::Out);
        ledger.clear("a");
        assert_eq!(ledger.readiness("a", true), LoginReadiness::Ready);
        assert_eq!(ledger.readiness("a", false), LoginReadiness::Out, "signed out is out");
    }
}
