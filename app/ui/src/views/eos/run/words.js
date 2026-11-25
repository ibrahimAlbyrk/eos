// What the run view and the routine page say for a run's words (01 §4.4):
// where it came from, its state with how long it has been at it, why it
// stopped, and who worked on it.

import { fmtUsd } from "../../../lib/format.js";

const ORIGINS = {
  hand: "Started by hand",
  trigger: "Started by a trigger",
  routine: "Started by another routine",
  agent: "Started from a chat",
  again: "Run again",
  trial: "A trial",
  replay: "A replay",
  surface: "Started from a page",
};

export const originLine = (origin) => ORIGINS[origin] ?? "Started";

// The short names the Runs tab filters by.
export const ORIGIN_FILTERS = {
  hand: "By hand",
  trigger: "Triggered",
  again: "Again",
  trial: "Trials",
  routine: "By a routine",
  agent: "From a chat",
  replay: "Replays",
  surface: "From a page",
};

export const ROLES = { lead: "Lead", solo: "Worker", script: "Script", specialist: "Specialist", checker: "Checker" };

const AGENT_STATES = {
  SPAWNING: "starting",
  WORKING: "working",
  IDLE: "waiting",
  ENDING: "done",
  DONE: "done",
  KILLING: "stopping",
  SUSPENDED: "resting",
};

export const agentStateWord = (state) => AGENT_STATES[String(state).toUpperCase()] ?? "waiting";

// A span of time in words: "under a minute", "3 min", "1 h 5 min".
export function duration(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}

const ENDED = new Set(["done", "skipped", "cancelled", "failed"]);
export const hasEnded = (run) => ENDED.has(run.state);

// How long the run has been at it: from its start to its end, or to now.
export const elapsed = (run, now) => (run.startedAt == null ? 0 : (run.endedAt ?? now) - run.startedAt);

// The state chip's words and the tone of its dot.
export function stateChip(run, now) {
  const took = duration(elapsed(run, now));
  switch (run.state) {
    case "queued": return { tone: null, text: "Queued" };
    case "running": return { tone: "active", text: `Working, ${took}` };
    case "checking": return { tone: "active", text: `Checking, ${took}` };
    case "waiting_for_user": return { tone: "active", text: "Waiting for you" };
    case "delivering": return { tone: "active", text: "Sending" };
    case "paused": return { tone: "warn", text: "Paused" };
    case "done": return { tone: "ok", text: `Done in ${took}` };
    case "skipped": return { tone: null, text: "Skipped" };
    case "cancelled": return { tone: null, text: "Stopped" };
    case "failed": return { tone: "err", text: "Failed" };
    default: return { tone: null, text: run.state };
  }
}

// Why a run failed, was skipped, stopped or paused, in words.
const REASONS = {
  no_result: "It ended twice without handing in a result.",
  check_failed: "Its result failed the check twice.",
  check_error: "The check itself broke twice.",
  crashed: "One of its agents crashed.",
  interrupted: "Eos stopped twice while it worked.",
  budget_run: "It spent all the money one run may spend.",
  budget_time: "It ran out of the time one run may take.",
  capability: "A capability it reads with is missing or broken.",
  no_credential: "A sign-in it needs is missing or no longer works.",
  invalid: "Its blueprint no longer passes the rules.",
  delivery: "Its result could not be sent.",
  superseded: "A newer run of the same item took its place.",
  day_cap: "Today's spending limit was reached.",
  too_late: "It waited too long to start.",
  queue_full: "Too many runs were waiting.",
  user: "You stopped it.",
  halted: "Everything was stopped.",
  moved: "Another Mac runs this routine.",
  internal: "Something went wrong inside Eos.",
};

// The lead's own words say why when it reported that the run cannot be done.
export function reasonLine(run) {
  if (run.reason === "reported") return run.headline ?? "Its lead said the run cannot be done.";
  if (run.reason === "user" && run.state === "paused") return "You paused it.";
  return REASONS[run.reason] ?? "Something went wrong.";
}

const RESULTS = { usual: "As usual", ask: "Ask me first", showOnly: "Show me only" };
export const resultWord = (mode) => RESULTS[mode] ?? RESULTS.usual;

// A run that shows its result to the user only: nothing leaves.
export const isShownOnly = (detail) => detail.input.result === "showOnly" || detail.run.origin === "trial";

// What the run is about: its item's title, else how many items, else none.
export function itemLine(input) {
  const item = input.item;
  if (item) return item.title ?? item.url ?? item.path ?? item.key ?? "an item";
  if (input.items?.length) return `${input.items.length} items`;
  return null;
}

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const agentsWord = (n) => `${NUMBERS[n] ?? n} ${n === 1 ? "agent" : "agents"}`;
const STATION_WORDS = { brief: "the brief", work: "the work", check: "the check", gate: "the gate", deliver: "sending" };

// Where the run stands, said under its sentence as Home's second line says
// the day: how long it has been at it and with whom, or how it ended, with
// the tone of the mark that hangs before it when it needs the user or broke.
export function standingLine({ run, agents }, now) {
  const took = duration(elapsed(run, now));
  const working = agents.filter((a) => agentStateWord(a.state) === "working").length;
  const at = STATION_WORDS[run.station];
  switch (run.state) {
    case "queued": return { text: "It starts as soon as Eos has room for it." };
    case "running":
    case "checking":
      return { text: working ? `${capital(agentsWord(working))} at work, ${took} in.` : `${capital(took)} in.` };
    case "waiting_for_user": return { text: "Nothing goes out until you answer.", tone: "active" };
    case "delivering": return { text: `Checked and passed, ${took} in.` };
    case "paused": return { text: at ? `It waits at ${at} until it may go on.` : "It waits until it may go on.", tone: "warn" };
    case "done": return { text: `Done in ${took} for ${fmtUsd(run.costUsd)}.` };
    case "skipped": return { text: "It never started." };
    case "cancelled": return { text: run.station ? `It stopped at ${at}, ${took} in.` : "It stopped before it started." };
    case "failed": return { text: reasonLine(run), tone: "err" };
    default: return { text: "" };
  }
}
