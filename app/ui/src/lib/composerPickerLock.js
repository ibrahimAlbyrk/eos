// Once a conversation has started, the composer's provider + model pickers lock.
// The signal is simply a selected worker: a worker only exists after its boot
// prompt was sent, so a selection always means the session has >= 1 message. The
// new-spawn composer (no worker selected) is the only state where the pickers
// stay live — before the first message they behave exactly as before.
export function pickerLocked(selected) {
  return !!selected;
}

// The MODEL pill is a narrower lock: provider stays immutable mid-session, but the
// model may be switched live on a backend whose descriptor reports
// runtimeModelSwitch. So it stays locked once a conversation has started UNLESS
// that capability is present. `runtimeModelSwitch` comes from the worker's backend
// descriptor (backendCaps), never a kind literal.
export function modelPickerLocked(selected, runtimeModelSwitch) {
  return pickerLocked(selected) && !runtimeModelSwitch;
}
