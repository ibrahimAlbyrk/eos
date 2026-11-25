// What the Capabilities screens say for the core's words (06 G10, §6). A word
// from a newer core that is not here shows as it came.

const STATES = {
  ready: { word: "Ready", tone: "ok", line: "Working." },
  degraded: { word: "Slow", tone: "warn", line: "Working, but slower than usual." },
  needs_sign_in: { word: "Needs sign-in", tone: "warn", line: "Sign in again to use it." },
  needs_setup: { word: "Needs setup", tone: "warn", line: "It needs a step from you first." },
  broken: { word: "Broken", tone: "err", line: "It stopped working." },
  disabled: { word: "Disabled", tone: null, line: "You turned it off." },
  available: { word: "Not installed", tone: null, line: "It is set up on another Mac. Install it here to use it on this one." },
};

const CODES = {
  scope_missing: "Its sign-in lacks a permission Eos needs. Sign in again.",
  automation_denied: "macOS has not let it control the app it needs.",
  http_401: "The service no longer accepts its sign-in.",
  hash_mismatch: "Its files changed after they were checked.",
  program_missing: "A program it needs is not installed.",
  sandbox_unavailable: "Its sandbox is not available.",
  server_crashed: "Its server stopped three times in ten minutes.",
  tools_changed: "Its server offers tools that were not reviewed.",
  rate_limited: "The service is limiting how often Eos may ask.",
  health_failed: "Its last checks failed.",
  output_schema: "Its answers no longer have the shape it promised.",
  source_gone: "What a routine reads through it is gone, such as a deleted repository.",
};

export const stateWord = (row) => STATES[row.state]?.word ?? row.state;

export const stateTone = (row) => STATES[row.state]?.tone ?? null;

// Why it is in its state, in a sentence.
export function stateLine(row) {
  const code = row.stateCode ?? "";
  if (code.startsWith("secret_missing:")) return "A secret it needs is missing.";
  if (code === "client_id_missing") return `Eos has no ${row.name ?? "service"} client id to sign in with.`;
  return CODES[code] ?? STATES[row.state]?.line ?? "";
}

export const ORIGINS = {
  builtin: "Built in",
  forge: "Made by the Forge",
  registry: "From a registry",
  synced: "From another Mac",
};

export const FORMS = { skill: "Skill", script: "Script", mcp: "MCP server", plugin: "Plugin", builtin: "Built in" };

// How it runs and where it came from; a built-in is both in one word.
export function madeOf(row) {
  const origin = ORIGINS[row.origin] ?? row.origin;
  if (row.origin === "builtin") return [origin];
  return [row.form && (FORMS[row.form] ?? row.form), origin].filter(Boolean);
}

export const WORKS = { this_mac: "This Mac only", any_mac: "Any of your Macs" };

export const CLASSES = {
  read: "Only reads",
  write_local: "Changes things on this Mac",
  tell_user: "Tells you",
  speak: "Speaks for you to others",
  irreversible: "Cannot be taken back, or costs money",
};

export const VERSION_STATUSES = { proposed: "Proposed", installed: "Kept", retired: "Retired", rejected: "Turned down" };

// Why a call failed, by the failure kind the core names, where the item's
// own summary leaves out what to do.
export const FAILURES = {
  gone: "What it names is not there any more.",
  validation: "The service did not take it as written. Edit it and try again.",
};

export const OUTCOMES = { ok: "Worked", error: "Failed", denied: "Not allowed", timeout: "Took too long", busy: "Busy" };

// Who uses it: the routines by name once `names` (id → name) knows each
// one, else how many.
export function usedBy(row, names = {}) {
  const ids = row.usedBy ?? [];
  const n = ids.length;
  if (n === 0) return "No routine uses it";
  if (ids.every((id) => names[id])) return `Used by ${ids.map((id) => names[id]).join(", ")}`;
  return n === 1 ? "Used by 1 routine" : `Used by ${n} routines`;
}

// The built-ins that sign in: GitHub by a code, Slack in the browser.
export const signsIn = (row) => row.id === "github" || row.id === "slack";

// What the button that signs in says: Slack is connected.
export const signInLabel = (row) => (row.id === "slack" ? "Connect" : "Sign in");

// The one action that fixes a bad state: sign in, enable, or check again
// once the cause is gone. None for a capability that works.
export function fixFor(row) {
  if (row.state === "ready" || row.state === "available") return null;
  if (row.state === "disabled") return "enable";
  if (signsIn(row) && (row.state === "needs_sign_in" || row.state === "needs_setup")) return "sign-in";
  return "check";
}

export const FIX_LABELS = { "sign-in": "Sign in", enable: "Enable", check: "Check now" };

// The fix's label for `row`: Slack is connected, not signed in to.
export const fixLabel = (row, fix) => (fix === "sign-in" ? signInLabel(row) : FIX_LABELS[fix]);
