// "A conversation has started" — the signal for the PROVIDER pill's lock. A worker
// only exists after its boot prompt was sent, so a selection always means the
// session has >= 1 message. The provider pill combines this with its own finer rule
// (a same-infrastructure live switch stays allowed, see hasProviderSwitchTarget in
// backendCaps). The new-spawn composer (no worker selected) never locks.
export function pickerLocked(selected) {
  return !!selected;
}

// A worker actively on a turn. The at-rest states (idle/suspended/done — or no
// worker at all) are NOT busy. Reads the worker's EXISTING `state` field (the same
// signal the provider pill and the daemon's planBackendSwitch gate on), never a new
// one. Shared so the composer's pills have one busy definition.
const AT_REST_STATES = new Set(["IDLE", "SUSPENDED", "DONE"]);
export function workerBusy(selected) {
  return !!selected && !AT_REST_STATES.has(selected.state);
}

// The MODEL pill is INDEPENDENT of the provider lock. Its ONE lock reason: the
// worker is actively on a turn — changing the model mid-turn errors. When the
// worker is idle/stopped the pill is open, and a model change persists for the next
// turn (SetWorkerModel writes the row + validates against the provider's catalog),
// applied live when the backend supports it. So: busy → locked; idle → selectable,
// whether or not a provider switch is available.
export function modelPickerLocked(selected) {
  return workerBusy(selected);
}
