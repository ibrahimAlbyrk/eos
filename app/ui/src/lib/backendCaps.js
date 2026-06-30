// The UI's backend-descriptor cache + the helpers derived from it. The daemon's
// BackendDescriptors (the single source of truth) arrive via GET /api/ui-config
// and applyDescriptors() loads them here; every consumer reads this DATA, never a
// kind literal — adding a provider is daemon-side only, no UI change.
//
// Until ui-config arrives (a brief boot window) the map is empty and the helpers
// fall back to PTY-permissive defaults so controls aren't wrongly disabled.

const DESCRIPTORS = new Map(); // kind -> { kind, label, enabled, billing, capabilities }
let PROFILES = []; // configured named profiles: { name, kind, model, label }

export function applyDescriptors(list) {
  if (!Array.isArray(list)) return;
  DESCRIPTORS.clear();
  for (const d of list) {
    if (d && typeof d.kind === "string") DESCRIPTORS.set(d.kind, d);
  }
}

// Configured backend PROFILES (modelSource:"profile" lanes) from /api/ui-config.
// Each fixes its own model — the composer locks the model picker when one is picked.
export function applyProfiles(list) {
  PROFILES = Array.isArray(list) ? list.filter((p) => p && typeof p.name === "string") : [];
}

export function backendProfiles() {
  return PROFILES.slice();
}

// The model a named profile is pinned to (e.g. "deepseek-chat"), or null.
export function profileModel(name) {
  return (name ? PROFILES.find((p) => p.name === name)?.model : null) ?? null;
}

// Enabled providers as {value:kind,label}. Legacy: both pickers now derive from
// providerChoices() (configured providers only) — the new-spawn picker directly,
// the live worker's switch via providerSwitchTargets() below. Kept for its test.
export function providerOptions() {
  return [...DESCRIPTORS.values()]
    .filter((d) => d.enabled)
    .map((d) => ({ value: d.kind, label: d.label }));
}

// Can a RUNNING worker hand its conversation from sourceKind to targetKind? A
// frontend mirror of core's canHandoffBackend, kept deliberately coarse: the
// daemon (planBackendSwitch) is the authority and rejects anything finer — this
// only greys the obvious blocks so the menu doesn't offer a switch that will fail.
// A live handoff needs a shared conversation store; the UI descriptor doesn't
// carry sessionStore, but billing class partitions the live stores today
// (subscription → claude-transcript, metered → eos-conversation), so a cross-class
// move is the store mismatch. Unknown/not-yet-loaded kinds → allowed (don't
// disable on a guess; the daemon still decides).
export function canSwitchProvider(sourceKind, targetKind) {
  if (!sourceKind || !targetKind) return { ok: true };
  if (sourceKind === targetKind) return { ok: false, reason: "already on this provider" };
  const s = DESCRIPTORS.get(sourceKind);
  const t = DESCRIPTORS.get(targetKind);
  if (!s || !t) return { ok: true };
  if (t.enabled === false) return { ok: false, reason: "provider is not enabled" };
  if (s.billing !== t.billing) return { ok: false, reason: "different conversation store — no live handoff" };
  return { ok: true };
}

// The RUNNING worker's provider-switch list: the SAME configured providers as the
// new-spawn picker (providerChoices) — never a raw unconfigured kind — annotated
// for the live switch: which entry is the current backend, and which targets the
// daemon would refuse (greyed, with the reason). Switching is by kind, so a worker
// on a profile matches its choice by kind.
export function providerSwitchTargets(currentKind) {
  return providerChoices().map((c) => {
    const current = c.kind === currentKind;
    const chk = current ? { ok: true } : canSwitchProvider(currentKind, c.kind);
    return { ...c, current, disabled: !current && !chk.ok, reason: chk.ok ? null : chk.reason };
  });
}

// The real usable providers for the NEW-SPAWN picker — the SINGLE derivation
// shared by the composer and the Settings model section. Two sources, deduped by
// name:
//   • subscription Claude lanes from the descriptors (enabled + billing
//     "subscription") → claude-sdk AND claude-cli, as bare-kind providers;
//   • the operator's configured non-subscription PROFILES (openai / anthropic-api
//     / codex), e.g. deepseek.
// The shipped per-model default profiles (claude-sdk-opus, claude-cli-*) are
// subscription-kind → excluded from the profile half; they collapse into the kind
// providers + model selection. A subscription kind that ALSO has an operator
// profile of the same name (e.g. a tuned "claude-sdk") carries that profile so
// the spawn preserves its config.
// Entry: { name, label, kind, subscription, profile, model }
//   profile != null → spawn via backendProfile (preserves the profile config);
//   else a bare subscription kind → spawn via backendKind.
export function providerChoices() {
  const out = [];
  const seen = new Set();
  for (const d of DESCRIPTORS.values()) {
    if (!d.enabled || d.billing !== "subscription" || seen.has(d.kind)) continue;
    seen.add(d.kind);
    const prof = PROFILES.find((p) => p.name === d.kind) ?? null;
    out.push({ name: d.kind, label: d.label ?? d.kind, kind: d.kind, subscription: true, profile: prof ? prof.name : null, model: prof?.model ?? null });
  }
  for (const p of PROFILES) {
    if (DESCRIPTORS.get(p.kind)?.billing === "subscription" || seen.has(p.name)) continue;
    seen.add(p.name);
    out.push({ name: p.name, label: p.label ?? p.name, kind: p.kind, subscription: false, profile: p.name, model: p.model ?? null });
  }
  return out;
}

// Display name for a provider CHOICE in the spawn picker — the bare provider
// NAME, never the model. A subscription choice shows its clean descriptor label
// ("Claude SDK"); an operator profile shows its name ("deepseek") because the
// profile label embeds the model ("deepseek (deepseek-chat)"), which belongs on
// the separate model pill, not the provider pill.
export function providerName(choice) {
  if (!choice) return null;
  return choice.subscription ? (choice.label ?? choice.name) : choice.name;
}

// Display label for a RUNNING worker's provider pill — the provider NAME (matching
// the picker/panel), never the raw kind. A worker on a configured profile shows
// that profile's name ("deepseek"); a bare subscription kind shows its clean label
// ("Claude SDK"). Falls back to the kind label if no choice matches.
export function runningProviderLabel(worker) {
  if (!worker) return "—";
  const choices = providerChoices();
  const c =
    (worker.backend_profile ? choices.find((p) => p.name === worker.backend_profile) : null) ??
    choices.find((p) => p.kind === worker.backend_kind) ??
    null;
  return providerName(c) ?? backendLabel(worker.backend_kind);
}

// Resolve a provider choice NAME to the composer spawn fields (single source for
// the composer pick + the Settings seed). A name backed by an operator profile
// spawns via backendProfile (preserves the profile config); a bare subscription
// kind via backendKind. Unknown name → bare kind, so a stale default still spawns.
export function providerSpawn(name) {
  const c = providerChoices().find((p) => p.name === name) ?? null;
  if (!c) return { backendKind: name || null, backendProfile: null, model: null };
  return c.profile
    ? { backendKind: null, backendProfile: c.profile, model: c.model }
    : { backendKind: c.kind, backendProfile: null, model: c.model };
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
