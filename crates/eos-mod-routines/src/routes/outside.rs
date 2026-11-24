//! What a door outside Eos hands a run is never the user's own words (07 §4.3): the
//! selection under the shortcut, a Services request, a share, a Dock drop, a link, a share
//! from the phone, and what another program piped into the `eos` command. Whatever page or
//! command started the run, the core marks it here.

use eos_contracts::{OnceRequest, StartRunRequest};

/// The doors whose items come from outside Eos. The terminal's items and piped text come from
/// whatever program ran the command.
const OUTSIDE: [&str; 7] = ["link", "shortcut", "services", "share", "dock", "phone_share", "terminal"];

fn is_outside(door: &str) -> bool {
    OUTSIDE.contains(&door)
}

/// Every item of a start through an outside door is untrusted.
pub(super) fn mark_start(asked: &mut StartRunRequest) {
    if !is_outside(&asked.door) {
        return;
    }
    if let Some(item) = asked.input.item.as_mut() {
        item.untrusted = true;
    }
    for item in asked.input.items.iter_mut().flatten().chain(asked.items.iter_mut().flatten()) {
        item.untrusted = true;
    }
}

/// A one-off's text attachments through an outside door reach its models inside the
/// untrusted marker. The sentence is the user's: they typed it in the panel.
pub(super) fn mark_once(asked: &mut OnceRequest) {
    if !is_outside(&asked.door) {
        return;
    }
    let source = format!("door:{}", asked.door);
    for attachment in asked.attachments.iter_mut().filter(|a| a.kind == "text") {
        attachment.value = eos_domain::untrusted::wrap(&source, &attachment.value);
    }
}
