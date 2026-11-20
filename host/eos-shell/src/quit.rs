//! When a Quit the user asked for waits for an answer first, and what it says.
//!
//! Only the app menu's Quit and the menu-bar item's ask. `--quit` (the installer, `eos
//! stop`) never does, and a logout or shutdown is never held.

use crate::QuitCheck;

pub(crate) const TITLE: &str = "Quit Eos?";

/// The alert's detail when quitting must be confirmed; `None` quits at once. A quiet run is
/// automated: nobody is there to answer.
pub(crate) fn ask(check: QuitCheck, quiet: bool) -> Option<String> {
    if quiet {
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
        assert_eq!(ask(QuitCheck { active_runs: 0 }, false), None);
        assert_eq!(
            ask(QuitCheck { active_runs: 1 }, false).as_deref(),
            Some("1 run is working. It continues when Eos opens.")
        );
        assert_eq!(
            ask(QuitCheck { active_runs: 2 }, false).as_deref(),
            Some("2 runs are working. They continue when Eos opens.")
        );
        assert_eq!(ask(QuitCheck { active_runs: 2 }, true), None, "a quiet run is automated");
    }
}
