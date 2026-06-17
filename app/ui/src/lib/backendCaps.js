// UI capability gating derived from a worker's backend_kind. The daemon's
// AgentCapabilities live on the backend adapter (not persisted per-worker), so
// the UI gates controls on the kind: claude-cli (PTY) supports keystrokes + a
// runtime model switch (/model slash command); the structured backends
// (claude-sdk + the in-process API lanes) fix the model per session and have no
// keystroke channel. Keep in sync with the adapters' AgentCapabilities.

const PTY = { keystroke: true, runtimeModelSwitch: true };
const STRUCTURED = { keystroke: false, runtimeModelSwitch: false };

export function backendCaps(kind) {
  return !kind || kind === "claude-cli" ? PTY : STRUCTURED;
}

// Subscription-billed kinds (no metered cost — claude-cli + claude-sdk default to
// the Max/Pro plan) vs API-billed (the in-process API lanes are metered).
const SUBSCRIPTION_KINDS = new Set(["claude-cli", "claude-sdk"]);
export function backendBilled(kind) {
  return !!kind && !SUBSCRIPTION_KINDS.has(kind);
}
