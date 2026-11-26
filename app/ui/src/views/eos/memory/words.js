// What the Memory screen says for a note (08 §4.10): its kind, where it
// holds, who taught it, how it is doing and how strong it is.
import { numberWord } from "../home/homeWords.js";

export const KIND_FILTERS = [
  { kind: "lesson", label: "Lessons" },
  { kind: "fact", label: "Facts" },
  { kind: "skill", label: "Skills" },
  { kind: "example", label: "Good examples" },
];

const KINDS = {
  lesson: "A lesson",
  fact: "A fact",
  skill: "A skill",
  example: "A good example",
  episode: "Something that happened",
  playbook: "A playbook",
};

export const kindWord = (kind) => KINDS[kind] ?? "A note";

// The source chip: how the note's knowledge reached Eos, said as where it
// came from so it reads on its own beside the note.
const SOURCES = { said: "You told it", did: "From your edits", outcome: "From a failure", guess: "Its own guess" };

export const sourceWord = (trust) => SOURCES[trust] ?? "Learned";

const STATES = { trying: "Trying it", firm: "Firm", cooling: "Cooling", closed: "Closed" };

const times = (n) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

const sentence = (text) => {
  const t = text.trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
};

// "You shortened four before sending. Trying it, helped three times."
export function provenance(row) {
  const doing = [STATES[row.state] ?? row.state, row.helped > 0 && `helped ${times(row.helped)}`].filter(Boolean).join(", ");
  return [sentence(row.why ?? ""), sentence(doing)].filter(Boolean).join(" ");
}

// Strength on a five-step bar: never empty for a live note.
export const strengthSteps = (strength) => Math.min(5, Math.max(1, Math.round((strength ?? 0) * 5)));

// The name a scope is shown under; a routine's comes from the routines list.
export function scopeName(scope, routines) {
  if (scope.level === "everywhere") return "Everywhere";
  if (scope.level === "routine") return routines?.find((r) => r.id === scope.key)?.name ?? scope.label ?? scope.key;
  return scope.label || scope.key;
}

// "for game-client", "for PR Review", "for code work", "everywhere".
export function scopePhrase(scope, routines) {
  if (scope.level === "everywhere") return "everywhere";
  if (scope.level === "work") return `for ${scopeName(scope, routines)} work`;
  return `for ${scopeName(scope, routines)}`;
}

const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long" });
const clock = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const dayOf = (ms) => day.format(new Date(ms));
export const whenOf = (ms) => clock.format(new Date(ms));

const STATE_SINCE = { trying: "Trying", firm: "Firm", cooling: "Cooling", closed: "Closed" };

// "A lesson, for game-client. Trying since 9 November."
export function headline(detail, routines) {
  const first = detail.versions.reduce((at, v) => Math.min(at, v.at), detail.note.updatedAt);
  const state = STATE_SINCE[detail.note.state] ?? detail.note.state;
  return `${kindWord(detail.note.kind)}, ${scopePhrase(detail.note.scope, routines)}. ${state} since ${dayOf(first)}.`;
}

// A playbook's version: each one was kept only after replays on past items
// came closer to what the user sent (04 G12c). "Version 2, kept 23 November
// after a replay on past items came closer to what you sent."
export function playbookLine(detail) {
  if (detail.note.kind !== "playbook") return null;
  const kept = detail.versions.filter((v) => v.why === "rewritten");
  if (kept.length === 0) return null;
  const last = kept.reduce((a, b) => (b.rev > a.rev ? b : a));
  return `Version ${last.rev}, kept ${dayOf(last.at)} after a replay on past items came closer to what you sent.`;
}

// "Came back five times, used four. It helped three times."
export function helpLine(help) {
  if (help.recalled === 0) return "It has not come back yet.";
  const parts = [`Came back ${times(help.recalled)}, used ${times(help.used)}.`];
  if (help.helped > 0) parts.push(`It helped ${times(help.helped)}.`);
  if (help.hurt > 0) parts.push(`It was wrong ${times(help.hurt)}.`);
  return parts.join(" ");
}

// "An agent is about to push in game-client. It then reads:"
export const comesBackLine = (situation) => `${sentence(situation ?? "") || "Its subject comes up."} It then reads:`;

// The screen's lead: how much Eos learned this week, the count in words.
export const weeklyLine = (n) => (n > 0 ? `Eos learned ${n === 1 ? "one thing" : `${numberWord(n)} things`} this week, without asking.` : null);

// Thirty days after it was forgotten, a note cannot come back.
export const RESTORE_MS = 30 * 24 * 60 * 60 * 1000;

const capital = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const counted = (n, one, many) => (n === 1 ? `one ${one}` : `${numberWord(n)} ${many}`);

// The lead's second line: what Memory holds, in words.
// "Six notes from your work and twelve things about you."
export function holdsLine(summary) {
  if (!summary) return null;
  const work = summary.learned ?? 0;
  const about = summary.aboutYou ?? 0;
  if (work === 0 && about === 0) return "Nothing yet, from your work or about you.";
  const parts = [work > 0 && `${counted(work, "note", "notes")} from your work`, about > 0 && `${counted(about, "thing", "things")} about you`].filter(Boolean);
  return `${capital(parts.join(" and "))}.`;
}

// What a search found: "Two notes mention “push”." or "No note mentions “zebra”."
export function foundLine(n, q) {
  if (n === 0) return `No note mentions “${q}”.`;
  return `${capital(counted(n, "note", "notes"))} ${n === 1 ? "mentions" : "mention"} “${q}”.`;
}

