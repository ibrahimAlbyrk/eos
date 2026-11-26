// Memory's gallery states: Learned from work with nothing, a little and a
// lot, filtered and searched, reading and failing; a note open, being edited,
// forgotten with its way back, and gone; About you.

import { ROUTES } from "../../../api/routes.js";
import { notesPath } from "../../../state/eos/notesStore.js";
import memory from "./sample/memory.json";
import { withDreams } from "./sample/about-you.js";
import { setMemoryPage } from "../../../state/memoryViewStore.js";

const LINT = memory.details.find((d) => d.note.text.startsWith("Run lint")).note.id;
const SUMMARY = memory.details.find((d) => d.note.text.startsWith("Keep the summary")).note.id;
const note = (id) => `eos:/memory?tab=work&note=${id}`;
const DAY = 24 * 60 * 60 * 1000;

const notes = memory.notes.notes;
const page = (rows) => ({ notes: rows });
const matching = (q) => notes.filter((n) => `${n.text} ${n.why}`.toLowerCase().includes(q));

// What the search for `q` answers, the way the core filters by words.
const searched = (q) => (s) => ({ ...s, [notesPath({ q })]: page(matching(q)) });

// Nothing learned yet.
const nothing = (s) => ({
  ...s,
  [ROUTES.memorySummary]: { ...memory.summary, learned: 0, weekly: 0, scopes: [], kinds: {} },
  [ROUTES.memoryNotes]: page([]),
});

// Forty-two notes across four projects, three routines and everywhere.
const PLACES = [
  { level: "project", key: "pk-game", label: "game-client" },
  { level: "project", key: "pk-tools", label: "liveops-tools" },
  { level: "project", key: "pk-site", label: "studio-site" },
  { level: "routine", key: "rt-4k2n8q1x7m3p", label: "rt-4k2n8q1x7m3p" },
  { level: "routine", key: "rt-9d3f6h2j5k8l", label: "rt-9d3f6h2j5k8l" },
  { level: "everywhere", key: "", label: "" },
];
const LINES = [
  ["lesson", "Squash fixup commits before asking for review", "You squashed three by hand", "did"],
  ["fact", "The staging server restarts at 04:00", "A run failed at 04:01", "outcome"],
  ["skill", "Unity batch mode needs -nographics on CI", "A build hung twice", "outcome"],
  ["lesson", "Name branches after the ticket", "You renamed two branches", "did"],
  ["example", "Release notes lead with what players notice", "You said so", "said"],
  ["lesson", "Do not touch the generated localisation tables", "An edit was overwritten", "outcome"],
  ["fact", "Ibrahim reviews shader changes", "You said so", "said"],
];
const lots = (s) => {
  const many = [...notes];
  for (let i = 0; many.length < 42; i++) {
    const [kind, text, why, trust] = LINES[i % LINES.length];
    many.push({
      id: `mn-lot${String(i).padStart(9, "0")}`, kind, text: i < LINES.length ? text : `${text} (${Math.floor(i / LINES.length) + 1})`, why, source: "edits",
      state: i % 5 === 0 ? "cooling" : i % 2 ? "firm" : "trying", trust, helped: i % 6, used: (i % 6) + 1, strength: ((i * 37) % 100) / 100,
      scope: PLACES[i % PLACES.length], rev: 1, updatedAt: notes[0].updatedAt - i * DAY,
    });
  }
  const count = (p) => many.filter((n) => n.scope.level === p.level && n.scope.key === p.key).length;
  return {
    ...s,
    [ROUTES.memorySummary]: { ...memory.summary, learned: many.length, weekly: 9, scopes: PLACES.map((p) => ({ ...p, count: count(p) })) },
    [ROUTES.memoryNotes]: { notes: many.slice(0, 30), nextCursor: "c-30" },
  };
};

// The note open, forgotten a day ago: it can still come back.
const forgotten = (s) => {
  const path = ROUTES.memoryNote(LINT);
  const detail = s[path];
  return { ...s, [path]: { ...detail, note: { ...detail.note, forgottenAt: Date.now() - DAY } } };
};

// Forget pressed on the open note, the core answering it forgotten.
const forgetting = {
  sends: async (method, path) => {
    if (method === "DELETE" && path === ROUTES.memoryNote(LINT)) {
      const detail = memory.details.find((d) => d.note.id === LINT);
      return { ok: true, status: 200, body: { ...detail, note: { ...detail.note, forgottenAt: Date.now() } } };
    }
    return { ok: false, status: 403, body: { error: "sample data" } };
  },
  then: () => [...document.querySelectorAll(".eos-body button")].find((b) => b.textContent.trim() === "Forget")?.click(),
};

const clickText = (text) => () => [...document.querySelectorAll(".eos-body button")].find((b) => b.textContent.trim().startsWith(text))?.click();
const typeSearch = (q) => () => {
  const input = document.querySelector("main input[type=search]");
  if (!input) return;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, q);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

export const MEMORY_STATES = [
  { id: "memory-empty", label: "Memory · nothing learned yet", location: "eos:/memory", reads: nothing },
  { id: "memory-lots", label: "Memory · forty-two notes", location: "eos:/memory", reads: lots },
  { id: "memory-loading", label: "Memory · loading", location: "eos:/memory", answer: "loading" },
  { id: "memory-error", label: "Memory · cannot read", location: "eos:/memory", answer: "error" },
  { id: "memory-kind", label: "Memory · only lessons", location: "eos:/memory", reads: (s) => ({ ...s, [notesPath({ kind: "lesson" })]: page(notes.filter((n) => n.kind === "lesson")) }), then: clickText("Lessons") },
  { id: "memory-search", label: "Memory · searched", location: "eos:/memory", reads: searched("push"), then: typeSearch("push") },
  { id: "memory-search-none", label: "Memory · searched, nothing found", location: "eos:/memory", reads: searched("zebra"), then: typeSearch("zebra") },
  { id: "memory-note-plain", label: "Memory · a note with little to say", location: note(SUMMARY) },
  { id: "memory-note-edit", label: "Memory · a note being edited", location: note(LINT), then: clickText("Edit") },
  { id: "memory-note-forget", label: "Memory · a note just forgotten", location: note(LINT), ...forgetting },
  { id: "memory-note-forgotten", label: "Memory · a note forgotten a day ago", location: note(LINT), reads: forgotten },
  { id: "memory-dreams", label: "Memory · About you, the dream log", location: "eos:/memory?tab=about", held: withDreams(Date.now()), then: () => setMemoryPage("log") },
  { id: "memory-dreams-none", label: "Memory · About you, no dreams yet", location: "eos:/memory?tab=about", then: () => setMemoryPage("log") },
  { id: "memory-note-gone", label: "Memory · a note no longer here", location: note("mn-gone00000001") },
];
