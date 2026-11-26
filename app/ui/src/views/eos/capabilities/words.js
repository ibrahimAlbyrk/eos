// What the Capabilities screens say for the core's words (06 G10, §6). A word
// from a newer core that is not here shows as it came.

const STATES = {
  // "Ready" already says it works.
  ready: { word: "Ready", tone: "ok", line: "" },
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

// The one action that fixes a bad state, said as what it does: sign in,
// enable, enter a key, check again once the cause is gone. A step that
// happens on the capability's page (a key, a client id) is, in the list,
// "open" with the step's words. None for a capability that works.
export function fixFor(row, on = "list") {
  if (row.state === "ready" || row.state === "available") return null;
  if (row.state === "disabled") return "enable";
  const code = row.stateCode ?? "";
  if (code === "client_id_missing") return on === "page" ? "check" : "open-setup";
  if (signsIn(row) && (row.state === "needs_sign_in" || row.state === "needs_setup")) return "sign-in";
  const keyed = row.state === "needs_sign_in" || code.startsWith("secret_missing:");
  if (keyed) {
    if (on === "list") return "open-key";
    return (row.secrets ?? []).length > 0 ? "key" : "check";
  }
  if (row.state === "needs_setup") return on === "page" ? "check" : "open-setup";
  return "check";
}

export const FIX_LABELS = { "sign-in": "Sign in", enable: "Enable", check: "Check now", "open-setup": "Set it up", "open-key": "Sign in again" };

// The key a sign-in that is no longer accepted needs again: the missing one,
// else the first.
export function keyFor(row) {
  const secrets = row.secrets ?? [];
  const named = (row.stateCode ?? "").startsWith("secret_missing:") ? row.stateCode.slice("secret_missing:".length) : null;
  return secrets.find((s) => s.name === named) ?? secrets.find((s) => !s.set) ?? secrets[0] ?? null;
}

// The fix's label for `row`: Slack is connected, not signed in to; a key is
// entered or replaced by its own name.
export function fixLabel(row, fix) {
  if (fix === "sign-in") return signInLabel(row);
  if (fix === "key") {
    const key = keyFor(row);
    return key?.set ? `Replace ${key.label}` : `Enter ${key?.label ?? "its key"}`;
  }
  return FIX_LABELS[fix];
}

// What the user does before checking again, where only they can: a client id
// lives in Eos's config file.
export function setupStep(row) {
  if (row.stateCode === "client_id_missing") return `Set ${row.id}.clientId in Eos's config file, then check again.`;
  return "";
}

// Each form's glyph (16 viewBox), drawn in its ring: a built-in's box, a
// script's prompt, a server's plug, a plugin's piece, a skill's spark.
const FORM_GLYPHS = {
  builtin: "M3 4h10v8H3zM6 8h4",
  script: "M3.5 5l3 3-3 3M8.5 11.5h4",
  mcp: "M6 2.5v3M10 2.5v3M4.5 5.5h7V8a3.5 3.5 0 0 1-7 0zM8 11.5v2",
  plugin: "M3 5.5h2.6a1.6 1.6 0 1 1 3.2 0H11v2.6a1.6 1.6 0 1 1 0 3.2V13.5H3z",
  skill: "M8 2.5l1.4 4.1 4.1 1.4-4.1 1.4L8 13.5l-1.4-4.1L2.5 8l4.1-1.4z",
};
export const formGlyph = (row) => FORM_GLYPHS[row.origin === "builtin" ? "builtin" : row.form] ?? FORM_GLYPHS.builtin;

// "Uses 2 routines" said the other way round, short, for a row's side.
export function usedByShort(row) {
  const n = (row.usedBy ?? []).length;
  if (n === 0) return "Unused";
  return n === 1 ? "1 routine" : `${n} routines`;
}

const joinNames = (names) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

// The lead's second line: what those that need a look need, by name.
// "GitHub needs setting up; Linear needs a sign-in; RSS feeds stopped working."
const NEEDS = [
  ["needs_setup", (n) => `${n} ${n.includes(" and ") ? "need" : "needs"} setting up`],
  ["needs_sign_in", (n) => `${n} ${n.includes(" and ") ? "need" : "needs"} a sign-in`],
  ["broken", (n) => `${n} stopped working`],
  ["degraded", (n) => `${n} ${n.includes(" and ") ? "are" : "is"} slow`],
];
export function needsLine(list) {
  const parts = NEEDS.map(([state, say]) => {
    const names = list.filter((r) => r.state === state).map((r) => r.name);
    return names.length ? say(joinNames(names)) : null;
  }).filter(Boolean);
  if (parts.length === 0) return "Each one works as it should.";
  const line = parts.join("; ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}
