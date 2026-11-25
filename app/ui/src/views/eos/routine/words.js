// What the routine page says for a routine's words: why it is paused, what
// starts its runs and what became of the signals it was offered.

const PAUSED = {
  user: "Paused by you.",
  failures: "Paused after three failed runs in a row.",
  spend: "Paused after a run cost far more than usual.",
  sign_in: "Paused: a sign-in it needs no longer works.",
  capability: "Paused: a capability it needs is missing or broken.",
};

// A routine paused for a capability carries its id: `capability:<id>`.
export const pausedLine = (reason) =>
  PAUSED[reason] ?? (reason?.startsWith("capability:") ? `Paused until ${reason.slice("capability:".length)} works again.` : "Paused.");

const clock = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// A time as the trigger lines say it: "Mon 09:00".
export const timeAt = (ms) => clock.format(new Date(ms));

// A zone as people say it: "Europe/Istanbul" → "Istanbul".
export const zoneName = (zone) => zone.split("/").pop().replace(/_/g, " ");

const SOURCE_KINDS = {
  clock: "Its schedule",
  manual: "Started by hand",
  capability: "A capability",
  folder: "A folder",
  git: "A git repository",
  after: "Another routine's runs",
  "push-inbox": "Items sent to it",
};

// A source by what it reads: a capability's source by the capability's name
// and the action's words (`github.pulls` → "GitHub: pulls"), or its kind.
export function sourceName(source, capabilities = []) {
  if (!source.source) return SOURCE_KINDS[source.kind] ?? source.kind;
  const [id, ...action] = source.source.split(".");
  const name = capabilities.find((c) => c.id === id)?.name;
  return name && action.length > 0 ? `${name}: ${action.join(" ").replace(/[_-]/g, " ")}` : source.source;
}

const SOURCE_STATES = {
  active: "Working",
  "backing-off": "Trying again later",
  "needs-attention": "Needs you",
  off: "Off",
  stopped: "Stopped",
};

export const sourceStateWord = (state) => SOURCE_STATES[state] ?? state;

const SOURCE_ERRORS = {
  unreachable: "Could not reach it",
  unauthorized: "Sign in again",
  gone: "What it watched is gone",
  "no-access": "The sign-in may not read it",
  "rate-limited": "Asked to slow down",
  missing: "Not found on this Mac",
  "inside-data": "It is inside Eos's own data folder, which Eos does not watch",
  "too-many": "It holds more than 5,000 entries",
  "too-many-folders": "More than 20 folders are watched on this Mac",
  unreadable: "This Mac could not read it",
};

// Why a source is not working, or nothing when it is.
export function sourceReason(source) {
  if (source.state === "off") return "Polling is off in a development run";
  if (source.errorKind) return SOURCE_ERRORS[source.errorKind] ?? null;
  if (source.state === "needs-attention") return "Sign in again";
  if (source.state === "stopped") return "Nothing reads it any more";
  return null;
}

// The last poll after a gap: "14 items from while Eos was closed".
export const catchUpLine = (catchUp) => `${catchUp.items} ${catchUp.items === 1 ? "item" : "items"} from while Eos was closed`;

const DECISIONS = {
  run: "Ran",
  batched: "Waits to run with others",
  unmatched: "Turned away",
  undecided: "Not decided: a fact was missing",
  unsorted: "Not sorted yet",
  "over-limit": "Over its limit",
  superseded: "A newer version came",
  paused: "Came while it was paused",
  baseline: "There before it started",
  elsewhere: "Another Mac took it",
  "held-dev": "Held in a dev run",
  refused: "Refused",
  cancelled: "Cancelled",
};

export const decisionWord = (word) => DECISIONS[word] ?? word;

// A rule by its place in the Which: the core counts from 0, people from 1.
export const ruleName = (index) => `rule ${Number(index) + 1}`;

// What became of a signal for the routine; an unmatched one names its rule,
// or the model when the routine's question turned it away (reason `ask`).
export function decisionLine(decision) {
  if (decision.decision === "unmatched" && decision.reason === "ask") return "Turned away by the model's answer";
  if (decision.decision === "unmatched" && /^\d+$/.test(decision.reason ?? "")) return `Turned away by ${ruleName(decision.reason)}`;
  return decisionWord(decision.decision);
}

// The filters of the signal list, by decision.
export const SIGNAL_FILTERS = [
  ["", "All"],
  ["run", "Ran"],
  ["unmatched", "Turned away"],
  ["over-limit", "Over its limit"],
  ["paused", "Came while paused"],
  ["baseline", "There before it started"],
];

// The decisions whose signals can all be run at once.
export const RUN_THEM = new Set(["over-limit", "paused", "baseline"]);

// A signal that never started a run can be run anyway.
export const canRunAnyway = (decision) => decision.decision !== "run" && decision.decision !== "batched";

// What a replay of one signal answered, or a dev run's refusal.
export function replayLine(replay) {
  if (replay === "dev-run") return "Not run: this is a dev run.";
  if (replay.decision === "run") return "Running it now.";
  return `Decided again: ${decisionWord(replay.decision)}.`;
}
