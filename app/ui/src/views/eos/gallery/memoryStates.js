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
  { level: "routine", key: "rt-7b3m1c9d0e4f", label: "rt-7b3m1c9d0e4f" },
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
  ["lesson", "Link the ticket in the first line of a review", "You added it four times", "did"],
  ["fact", "The shop scene loads its banners late", "A test timed out", "outcome"],
  ["skill", "Rebuild the addressables before a device test", "A build missed new art", "outcome"],
  ["lesson", "Keep a paper's lead story under 120 words", "You cut two leads", "did"],
  ["fact", "Tiles are pooled per scene", "A review flagged a leak", "outcome"],
  ["example", "A review that lists the blocking finding first", "You kept it unedited", "did"],
  ["lesson", "Skip funding news in the morning paper", "You skipped it three weeks", "did"],
  ["fact", "CI caches the Library folder for a day", "A build used a stale cache", "outcome"],
  ["skill", "Profile the loader with the deep profiler off", "The profiler stalled a run", "outcome"],
  ["lesson", "Ask before pushing to a release branch", "You said so", "said"],
  ["fact", "The leaderboard API limits to 30 calls a minute", "A run was throttled", "outcome"],
  ["lesson", "Group changelog lines by what players see", "You moved six lines", "did"],
  ["fact", "Haptics follow the system setting", "You said so", "said"],
  ["skill", "Run the snapshot tests at 1x scale", "Two snapshots differed", "outcome"],
  ["lesson", "Mention the build number in a failure note", "You added it twice", "did"],
  ["fact", "The publisher writes from two addresses", "Mail Triage missed one", "outcome"],
  ["example", "A morning paper with one long read", "You marked it a good issue", "did"],
  ["lesson", "Keep shader reviews to the changed passes", "You trimmed two reviews", "did"],
  ["fact", "The save slot format changed in 2.3", "A run read old saves", "outcome"],
  ["skill", "Clear the shader cache after an SDK bump", "A build showed pink materials", "outcome"],
  ["lesson", "Say which file a finding is in", "You asked twice", "said"],
  ["fact", "Release branches are named release/x.y", "A run looked for main", "outcome"],
  ["lesson", "Do not review generated protobuf files", "You dismissed three findings", "did"],
  ["fact", "The tools repo has no CI on weekends", "A check waited all Saturday", "outcome"],
  ["example", "A note that says only what broke", "You sent it unedited", "did"],
  ["lesson", "Batch draw-call findings into one comment", "You merged four comments", "did"],
  ["fact", "Night builds run at 02:00", "A run collided with one", "outcome"],
  ["skill", "Read crash logs from the newest first", "A run read a stale log", "outcome"],
  ["lesson", "Leave style nits out of blocking findings", "You moved two to nits", "did"],
];
const lots = (s) => {
  const many = [...notes];
  for (let i = 0; many.length < 42; i++) {
    const [kind, text, why, trust] = LINES[i % LINES.length];
    many.push({
      id: `mn-lot${String(i).padStart(9, "0")}`, kind, text, why, source: "edits",
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
  sends: async (method, path, _body, read) => {
    if (method === "DELETE" && path === ROUTES.memoryNote(LINT)) {
      const detail = (await read.get(path)).body;
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
