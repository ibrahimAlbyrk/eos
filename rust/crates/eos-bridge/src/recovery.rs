//! What happens when a view's renderer dies (`app/src/main/index.ts` wireRendererRecovery,
//! `artifacts/viewEvents.ts`).
//!
//! A dead renderer leaves a view blank until someone reloads it, so the shell reloads it
//! once; a second death within [`RELOAD_GUARD`] of that reload is left alone, so a page that
//! crashes as it boots cannot spin. That is the dashboard's rule today, and here also the
//! rule of every view that shows a whole page of its own: a browser tab, a paired computer's
//! view. An artifact view instead says that its page stopped; the dashboard offers Retry.

use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const RELOAD_GUARD: Duration = Duration::from_secs(10);

/// Which of the shell's views a view label names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViewKind {
    Dashboard,
    BrowserTab,
    Artifact,
    /// A paired computer's view, in the main window or a window of its own.
    Host,
    /// A short-lived view (a sign-in page, a plugin preview, a splash): nothing to keep.
    Other,
}

impl ViewKind {
    /// From the labels the shell gives its views.
    pub fn of(label: &str) -> Self {
        match label {
            "main" => ViewKind::Dashboard,
            l if l.starts_with("bt-") => ViewKind::BrowserTab,
            l if l.starts_with("art-") => ViewKind::Artifact,
            l if l.starts_with("host-") || (l.starts_with("hostwin-") && l.ends_with("-view")) => ViewKind::Host,
            _ => ViewKind::Other,
        }
    }
}

/// What the shell does about a dead renderer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterCrash {
    Reload,
    /// It died again soon after the last reload.
    LeaveDead,
    /// The artifact views' pool reports it on the view.
    TellArtifacts,
    Nothing,
}

/// The reloads made recently, by view label. Only reloads younger than [`RELOAD_GUARD`] are
/// kept, so it holds at most the views that crashed in the last ten seconds.
#[derive(Debug, Default)]
pub struct Recovery {
    reloaded: HashMap<String, Instant>,
}

impl Recovery {
    pub fn after_crash(&mut self, label: &str, now: Instant) -> AfterCrash {
        match ViewKind::of(label) {
            ViewKind::Artifact => AfterCrash::TellArtifacts,
            ViewKind::Other => AfterCrash::Nothing,
            ViewKind::Dashboard | ViewKind::BrowserTab | ViewKind::Host => {
                self.reloaded.retain(|_, at| now.saturating_duration_since(*at) < RELOAD_GUARD);
                if self.reloaded.contains_key(label) {
                    return AfterCrash::LeaveDead;
                }
                self.reloaded.insert(label.to_owned(), now);
                AfterCrash::Reload
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_name_their_views() {
        assert_eq!(ViewKind::of("main"), ViewKind::Dashboard);
        assert_eq!(ViewKind::of("bt-0000aac70001"), ViewKind::BrowserTab);
        assert_eq!(ViewKind::of("art-0000aac70002"), ViewKind::Artifact);
        assert_eq!(ViewKind::of("host-ab12"), ViewKind::Host);
        assert_eq!(ViewKind::of("hostwin-3-view"), ViewKind::Host);
        assert_eq!(ViewKind::of("hostwin-3"), ViewKind::Other, "the window itself has no page");
        assert_eq!(ViewKind::of("signin-claude-view"), ViewKind::Other);
        assert_eq!(ViewKind::of("mainly"), ViewKind::Other);
    }

    #[test]
    fn a_view_is_reloaded_once_and_left_when_it_dies_again_within_ten_seconds() {
        let mut recovery = Recovery::default();
        let start = Instant::now();
        assert_eq!(recovery.after_crash("main", start), AfterCrash::Reload);
        assert_eq!(recovery.after_crash("bt-1", start), AfterCrash::Reload, "each view counts for itself");
        assert_eq!(recovery.after_crash("main", start + Duration::from_secs(9)), AfterCrash::LeaveDead);
        assert_eq!(recovery.after_crash("main", start + RELOAD_GUARD), AfterCrash::Reload);
        assert_eq!(recovery.reloaded.len(), 1, "old reloads are forgotten");
        assert_eq!(recovery.after_crash("art-1", start), AfterCrash::TellArtifacts);
        assert_eq!(recovery.after_crash("signin-x-view", start), AfterCrash::Nothing);
    }
}
