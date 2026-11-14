//! Which update phase may follow which: the rule book the update service drives;
//! a move not listed here is refused. `off` has no ways in or out: a build from
//! source stays off for its whole life. Applying never reaches a later phase: on
//! success the app quits and the new version starts fresh.

use eos_contracts::update::UpdatePhase;

/// The phases `from` may move to.
pub fn update_transitions(from: UpdatePhase) -> &'static [UpdatePhase] {
    use UpdatePhase::{Applying, Available, Checking, Downloading, Error, Idle, Off, Ready, Staging, Waiting};
    match from {
        Off => &[],
        Idle => &[Checking],
        // ready: this version was staged before the app restarted.
        Checking => &[Idle, Available, Downloading, Ready, Error],
        Available => &[Checking, Downloading],
        // available: downloading was cancelled or turned off.
        Downloading => &[Staging, Available, Error],
        // available: cancelled while the bundle was being built.
        Staging => &[Ready, Available, Error],
        // checking: a newer release may have appeared meanwhile.
        Ready => &[Checking, Waiting, Applying],
        Waiting => &[Applying, Ready],
        Applying => &[Error],
        Error => &[Checking, Idle],
    }
}

pub fn can_update_transition(from: UpdatePhase, to: UpdatePhase) -> bool {
    from == to || update_transitions(from).contains(&to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use UpdatePhase::{Applying, Checking, Downloading, Idle, Off, Ready, Staging, Waiting};

    #[test]
    fn the_forward_path_is_allowed_and_shortcuts_are_refused() {
        for (from, to) in [
            (Idle, Checking),
            (Checking, Downloading),
            (Downloading, Staging),
            (Staging, Ready),
            (Ready, Waiting),
            (Waiting, Applying),
        ] {
            assert!(can_update_transition(from, to), "{from:?} → {to:?}");
        }
        assert!(!can_update_transition(Idle, Ready));
        assert!(!can_update_transition(Downloading, Applying));
        assert!(!can_update_transition(Off, Checking));
        assert!(can_update_transition(Ready, Ready));
    }

    #[test]
    fn every_phase_the_contract_names_has_its_rule() {
        for name in eos_contracts::update::UPDATE_PHASES {
            let phase: UpdatePhase =
                serde_json::from_value(serde_json::Value::String((*name).to_owned())).expect("a phase");
            // `off` is the only dead end besides the terminal hand-over.
            assert_eq!(update_transitions(phase).is_empty(), phase == Off, "{name}");
        }
    }
}
