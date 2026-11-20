//! When a Quit the user asked for waits for an answer first, and what it says.
//!
//! Only the app menu's Quit and the menu-bar item's ask. `--quit` (the installer, `eos
//! stop`) never does, and a logout or shutdown is never held.

use crate::QuitCheck;

pub(crate) const TITLE: &str = "Quit Eos?";

/// The alert's detail when quitting must be confirmed; `None` quits at once. `shown`: the
/// menu-bar item shows (the Eos preview is on or a routine exists); the confirm comes only
/// with it. A quiet run is automated: nobody is there to answer.
pub(crate) fn ask(check: QuitCheck, shown: bool, quiet: bool) -> Option<String> {
    if quiet || !shown {
        return None;
    }
    match check.active_runs {
        0 => None,
        1 => Some("1 run is working. It continues when Eos opens.".to_owned()),
        n => Some(format!("{n} runs are working. They continue when Eos opens.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quitting_asks_only_while_runs_work() {
        let runs = |active_runs| QuitCheck { active_runs };
        assert_eq!(ask(runs(0), true, false), None);
        assert_eq!(ask(runs(1), true, false).as_deref(), Some("1 run is working. It continues when Eos opens."));
        assert_eq!(ask(runs(2), true, false).as_deref(), Some("2 runs are working. They continue when Eos opens."));
        assert_eq!(ask(runs(2), true, true), None, "a quiet run is automated");
    }

    #[test]
    fn quitting_never_asks_without_the_preview_or_a_routine() {
        assert_eq!(ask(QuitCheck { active_runs: 2 }, false, false), None);
    }
}
