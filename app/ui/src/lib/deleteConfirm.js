// Suppress logic for the permanent-delete confirmations. The settings are
// daemon-persisted (settings.json) and surfaced as toggles in Settings →
// General → Confirmations, so a "don't ask again" tick in a dialog is
// reversible from the panel. Live delete and archive purge get SEPARATE keys:
// suppressing one must never silently suppress the other.
export const DELETE_CONFIRM_KEY = "confirm.agentDelete";
export const PURGE_CONFIRM_KEY = "confirm.archivePurge";

// Unset (fresh install / settings load failed) must mean "ask" — only an
// explicit false suppresses the dialog.
const suppressed = (settings, key) => settings?.[key] === false;

export function shouldConfirmDelete(settings) {
  return !suppressed(settings, DELETE_CONFIRM_KEY);
}

export function shouldConfirmPurge(settings) {
  return !suppressed(settings, PURGE_CONFIRM_KEY);
}
