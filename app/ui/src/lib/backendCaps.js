// The UI's backend-descriptor cache + the helpers derived from it. The daemon's
// BackendDescriptors (the single source of truth) arrive via GET /api/ui-config
// and applyDescriptors() loads them here; every consumer reads this DATA, never a
// kind literal — adding a provider is daemon-side only, no UI change.
//
// Until ui-config arrives (a brief boot window) the map is empty and the helpers
// fall back to PTY-permissive defaults so controls aren't wrongly disabled.

const DESCRIPTORS = new Map(); // kind -> { kind, label, enabled, billing, capabilities }

export function applyDescriptors(list) {
  if (!Array.isArray(list)) return;
  DESCRIPTORS.clear();
  for (const d of list) {
    if (d && typeof d.kind === "string") DESCRIPTORS.set(d.kind, d);
  }
}

// Enabled providers for the Settings → Provider picker (value = kind, label = UI name).
export function providerOptions() {
  return [...DESCRIPTORS.values()]
    .filter((d) => d.enabled)
    .map((d) => ({ value: d.kind, label: d.label }));
}

// Capabilities the UI gates controls on (keystroke rewind, runtime model switch).
// Unknown/not-yet-loaded kind → PTY-permissive (don't disable a control on a guess).
const PTY_DEFAULT_CAPS = { keystroke: true, rewind: true, runtimeModelSwitch: true };
export function backendCaps(kind) {
  return (kind ? DESCRIPTORS.get(kind)?.capabilities : null) ?? PTY_DEFAULT_CAPS;
}

// True when the provider is metered (per-token API cost) rather than subscription.
// Unknown kind → false (don't show "billed" on a guess).
export function backendBilled(kind) {
  return (kind ? DESCRIPTORS.get(kind)?.billing : null) === "metered";
}

// Display label for a provider kind (e.g. "Claude SDK"). Unknown/not-yet-loaded
// → the raw kind, never blank, so the provider pill always reads sensibly.
export function backendLabel(kind) {
  return (kind ? DESCRIPTORS.get(kind)?.label : null) ?? kind ?? "—";
}
