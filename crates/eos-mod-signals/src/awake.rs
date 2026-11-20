//! Keeping the computer working for routines (02 §3 A.8–9, G.40).
//!
//! Two work holds, each taken when its count leaves 0 and dropped when it
//! comes back: `Armed` while an active routine held here has a schedule, so
//! the app does not nap while it waits for a slot; `Run` while a run of a
//! routine held here is running, checking or delivering, while a pass after
//! a wake (or a resume) writes its admissions, and, with the setting
//! [`KEEP_AWAKE`] on and the computer on mains power, while a schedule is
//! armed. The counts are read from the store after each scheduler pass,
//! outside any write job.
//!
//! The first time a schedule fires over [`OFFER_LATE_MS`] late, one notice
//! offers the setting; [`OFFERED`] remembers that it was, once per computer.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use eos_contracts::{RoutineState, SettingValue, Trigger, UserSettings};
use eos_core::Error;
use eos_core::os::{AwakeHold, HoldReason, Power, WorkHold};
use eos_core::routine::RoutineDirectory;
use eos_core::signals::{Holder, Runner};
use eos_core::store::{Store, UserSettingsStore};
use eos_domain::inbox::ItemKind;
use eos_inbox::{NewItem, Opening, notice_in};
use serde_json::json;

use crate::router::{Router, halted_in};

/// Keep the computer awake on mains power while a schedule is armed.
pub(crate) const KEEP_AWAKE: &str = "signals.keepAwakeForSchedules";
/// The keep-awake offer was made on this computer.
pub(crate) const OFFERED: &str = "signals.keepAwakeOffered";
/// A schedule that fires this late offers to keep the computer awake.
pub const OFFER_LATE_MS: i64 = 30 * 60_000;
/// The subject of the offer's notice.
const OFFER_SUBJECT: &str = "keep-awake";
const HOUR_MS: i64 = 60 * 60_000;

/// Whether the flag `key` is on.
pub(crate) fn flag(settings: &UserSettings, key: &str) -> bool {
    matches!(settings.get(key), Some(SettingValue::Flag(true)))
}

/// What the holds follow.
#[derive(Default)]
struct Held {
    armed: Option<Box<dyn AwakeHold>>,
    run: Option<Box<dyn AwakeHold>>,
    /// An active routine held here has a schedule.
    scheduled: bool,
    /// Runs of routines held here at work.
    runs: i64,
    /// The setting is on and the computer draws mains power.
    keep: bool,
    catching_up: bool,
}

pub(crate) struct Awake {
    pub(crate) hold: Arc<dyn WorkHold>,
    pub(crate) power: Arc<dyn Power>,
    pub(crate) settings: Arc<dyn UserSettingsStore>,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) runner: Arc<dyn Runner>,
    pub(crate) directory: Arc<dyn RoutineDirectory>,
    /// The computer woke or Eos resumed: the next pass catches up.
    pub(crate) woke: AtomicBool,
    held: Mutex<Held>,
}

/// Holds `Run` while a pass after a wake writes its admissions.
pub(crate) struct CatchUp<'a>(&'a Awake);

impl Drop for CatchUp<'_> {
    fn drop(&mut self) {
        self.0.change(|held| held.catching_up = false);
    }
}

impl Awake {
    pub(crate) fn new(parts: AwakeParts) -> Self {
        let AwakeParts { hold, power, settings, store, runner, directory } = parts;
        Self { hold, power, settings, store, runner, directory, woke: AtomicBool::new(false), held: Mutex::default() }
    }

    fn held(&self) -> MutexGuard<'_, Held> {
        self.held.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Applies `edit`, then takes or drops each hold as its count wants.
    fn change(&self, edit: impl FnOnce(&mut Held)) {
        let mut held = self.held();
        edit(&mut held);
        let run = held.runs > 0 || held.catching_up || (held.keep && held.scheduled);
        if !held.scheduled {
            held.armed = None;
        } else if held.armed.is_none() {
            held.armed = self.hold.begin(HoldReason::Armed);
        }
        if !run {
            held.run = None;
        } else if held.run.is_none() {
            held.run = self.hold.begin(HoldReason::Run);
        }
    }

    /// A pass that catches up after a wake, when one is due.
    pub(crate) fn catch_up(&self) -> Option<CatchUp<'_>> {
        if !self.woke.swap(false, Ordering::SeqCst) {
            return None;
        }
        self.change(|held| held.catching_up = true);
        Some(CatchUp(self))
    }

    /// Counts again what the holds follow.
    pub(crate) async fn refresh(&self) -> Result<(), Error> {
        let routines = self.directory.triggers().await?;
        let here = |id: &str| matches!(self.runner.holder(id), Holder::Here { .. });
        let held: Vec<_> = routines.iter().filter(|routine| here(&routine.id)).collect();
        let (halted, working) = self.store.read(|tx| Ok((halted_in(tx)?, tx.runs().working()?))).await?;
        let runs = working.iter().filter(|(routine_id, _)| here(routine_id)).map(|(_, runs)| runs).sum();
        let scheduled = !halted
            && held.iter().any(|routine| {
                routine.state == RoutineState::Active
                    && routine.when.on.iter().any(|trigger| matches!(trigger, Trigger::Schedule { .. }))
            });
        let (power, settings) = (self.power.clone(), self.settings.clone());
        let keep =
            tokio::task::spawn_blocking(move || flag(&settings.read(), KEEP_AWAKE) && !power.status().on_battery)
                .await
                .map_err(|error| Error::Storage(error.to_string()))?;
        self.change(|held| {
            held.scheduled = scheduled;
            held.runs = runs;
            held.keep = keep;
        });
        Ok(())
    }

    /// Drops every hold.
    pub(crate) fn release(&self) {
        *self.held() = Held::default();
    }

    /// Offers to keep the computer awake for schedules, the first time one
    /// of `routine_id`'s fired `late_by_ms` late.
    pub(crate) async fn offer(&self, router: &Router, routine_id: &str, late_by_ms: i64) -> Result<(), Error> {
        let settings = self.settings.clone();
        let offered = tokio::task::spawn_blocking(move || flag(&settings.read(), OFFERED))
            .await
            .map_err(|error| Error::Storage(error.to_string()))?;
        if offered {
            return Ok(());
        }
        let (now, ids, zone, control) =
            (router.clock.now_ms(), router.ids.clone(), router.zone.clone(), router.control.clone());
        let routine_id = routine_id.to_owned();
        self.store
            .write(move |tx, out| {
                let name = tx.routines().find(&routine_id)?.map_or_else(|| "A routine".to_owned(), |row| row.name);
                let item = NewItem {
                    kind: ItemKind::Notice,
                    producer: "signals".into(),
                    routine_id: Some(routine_id.clone()),
                    run_id: None,
                    subject_key: Some(OFFER_SUBJECT.into()),
                    title: format!("{name} ran {} late because the Mac was asleep", late(late_by_ms)),
                    summary: "Eos can keep this Mac awake on power while a routine waits for its time.".into(),
                    payload: json!({ "actionLabel": "Keep the Mac awake for schedules" }),
                    by_hand: false,
                };
                let at = Opening { now, ids: ids.as_ref(), zone: zone.as_ref(), control: control.as_ref() };
                notice_in(tx, out, &at, item).map(drop)
            })
            .await?;
        let settings = self.settings.clone();
        let mark = [(OFFERED.to_owned(), SettingValue::Flag(true))].into_iter().collect();
        tokio::task::spawn_blocking(move || settings.patch(mark))
            .await
            .map_err(|error| Error::Storage(error.to_string()))??;
        tracing::info!(late_by_ms, "keeping the computer awake for schedules was offered");
        Ok(())
    }
}

/// How late, in words: whole hours from an hour on, else minutes.
fn late(ms: i64) -> String {
    if ms >= HOUR_MS { format!("{} h", ms / HOUR_MS) } else { format!("{} min", ms / 60_000) }
}

/// What [`Awake`] is built from.
pub(crate) struct AwakeParts {
    pub(crate) hold: Arc<dyn WorkHold>,
    pub(crate) power: Arc<dyn Power>,
    pub(crate) settings: Arc<dyn UserSettingsStore>,
    pub(crate) store: Arc<dyn Store>,
    pub(crate) runner: Arc<dyn Runner>,
    pub(crate) directory: Arc<dyn RoutineDirectory>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lateness_reads_in_whole_hours_from_an_hour_on() {
        assert_eq!((late(2 * HOUR_MS + 600_000), late(45 * 60_000)), ("2 h".into(), "45 min".into()));
    }
}
