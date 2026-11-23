//! How a surface's versions, issues and pins move, and which of its history
//! is dropped. Every rule takes the rows it decides on and returns its
//! verdict; the store applies it in one write.

use crate::limits::{KEPT_ISSUES, KEPT_VERSIONS, PIN_SLOTS, TRIAL_ISSUE_MS};
use crate::words::{IssueStatus, VersionStatus};

impl VersionStatus {
    /// `checking → candidate → kept | discarded`, `kept → superseded` when
    /// another version is kept. A failing check discards a version that is
    /// still checking. Restoring an old version makes a new one; nothing
    /// moves back.
    pub fn can_move_to(self, next: VersionStatus) -> bool {
        use VersionStatus::*;
        matches!(
            (self, next),
            (Checking, Candidate)
                | (Checking, Discarded)
                | (Candidate, Kept)
                | (Candidate, Discarded)
                | (Kept, Superseded)
        )
    }

    /// One version of a surface may be open for the user to decide on.
    pub fn is_open(self) -> bool {
        matches!(self, VersionStatus::Checking | VersionStatus::Candidate)
    }
}

impl IssueStatus {
    /// `preparing → ready | failed`; a ready issue stays ready.
    pub fn can_move_to(self, next: IssueStatus) -> bool {
        matches!((self, next), (IssueStatus::Preparing, IssueStatus::Ready | IssueStatus::Failed))
    }
}

/// What retention needs of one issue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueAge {
    pub id: String,
    pub created_at: i64,
    pub kept: bool,
    pub trial: bool,
}

/// The issues to drop: trial issues once [`TRIAL_ISSUE_MS`] passed since the
/// routine started, and of the rest every one past the newest
/// [`KEPT_ISSUES`] that the user did not mark Keep.
pub fn issues_to_drop(issues: &[IssueAge], started_at: Option<i64>, now: i64) -> Vec<String> {
    let trial_over = started_at.is_some_and(|at| now - at >= TRIAL_ISSUE_MS);
    let mut real: Vec<&IssueAge> = issues.iter().filter(|i| !i.trial).collect();
    real.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    let old = real.into_iter().skip(KEPT_ISSUES).filter(|i| !i.kept);
    let trials = issues.iter().filter(|i| i.trial && trial_over);
    trials.chain(old).map(|i| i.id.clone()).collect()
}

/// What retention needs of one version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionAge {
    pub version: i64,
    pub status: VersionStatus,
}

/// The versions to drop: never the current or the open one, never one an
/// issue still uses (`in_use`), and of the others all but the newest
/// [`KEPT_VERSIONS`].
pub fn versions_to_drop(versions: &[VersionAge], in_use: &[i64]) -> Vec<i64> {
    let mut free: Vec<i64> = versions
        .iter()
        .filter(|v| !v.status.is_open() && v.status != VersionStatus::Kept && !in_use.contains(&v.version))
        .map(|v| v.version)
        .collect();
    free.sort_unstable_by(|a, b| b.cmp(a));
    free.into_iter().skip(KEPT_VERSIONS).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinError {
    /// Every slot holds a surface already.
    Full,
}

/// The slot a surface gets on Home: the one it holds already, else the first
/// free one of the [`PIN_SLOTS`].
pub fn pin_slot(pins: &[(u8, String)], surface_id: &str) -> Result<u8, PinError> {
    if let Some((slot, _)) = pins.iter().find(|(_, id)| id == surface_id) {
        return Ok(*slot);
    }
    (1..=PIN_SLOTS).find(|slot| !pins.iter().any(|(taken, _)| taken == slot)).ok_or(PinError::Full)
}

/// A whole new set of pins in order: at most [`PIN_SLOTS`], each surface once.
pub fn arrange_pins(surface_ids: &[String]) -> Result<Vec<(u8, String)>, PinError> {
    let mut unique: Vec<&String> = Vec::new();
    for id in surface_ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    if unique.len() > usize::from(PIN_SLOTS) {
        return Err(PinError::Full);
    }
    Ok(unique.into_iter().zip(1..).map(|(id, slot)| (slot, id.clone())).collect())
}
