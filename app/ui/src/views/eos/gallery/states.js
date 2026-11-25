// The gallery's states (08 §10): each screen in each state it can be in,
// drawn from the samples. A state names where Eos opens and how the reads
// answer: the samples, the samples changed, nothing yet (loading), or a
// refusal (error). Nothing here reaches the core.

import { ROUTES } from "../../../api/routes.js";
import { RUNS_PATH } from "../../../state/eos/homeStore.js";
import inbox from "./sample/inbox.json";
import memory from "./sample/memory.json";
import paper from "./sample/paper.json";
import routineDetail from "./sample/routine-detail.json";
import routinePaused from "./sample/routine-paused.json";
import runDetail from "./sample/run-detail.json";

const PAPER = paper.surface.id;
const empty = { ...inbox, items: [], counts: { open: 0, later: 0, byKind: {}, byRoutine: {} } };

// { id, label, location, reads: (samples) → reads, answer?: "loading" | "error" }
export const GALLERY_STATES = [
  { id: "home", label: "Home · typical", location: "eos:/" },
  { id: "home-empty", label: "Home · nothing waiting", location: "eos:/", reads: (s) => ({ ...s, [ROUTES.inbox]: empty, [RUNS_PATH]: { runs: [] }, [ROUTES.surfaceTiles]: { tiles: [] } }) },
  { id: "home-first", label: "Home · first run", location: "eos:/", reads: (s) => ({ ...s, [ROUTES.routines]: [], [RUNS_PATH]: { runs: [] }, [ROUTES.inbox]: empty, [ROUTES.signalsRoutines]: [], [ROUTES.surfaceTiles]: { tiles: [] } }) },
  { id: "home-loading", label: "Home · loading", location: "eos:/", answer: "loading" },
  { id: "home-error", label: "Home · cannot read", location: "eos:/", answer: "error" },
  { id: "needs", label: "Needs you", location: "eos:/needs" },
  { id: "needs-empty", label: "Needs you · empty", location: "eos:/needs", reads: (s) => ({ ...s, [ROUTES.inbox]: empty }) },
  { id: "need", label: "Needs you · a draft", location: `eos:/needs/${inbox.items.find((i) => i.kind === "draft")?.id}` },
  { id: "routines", label: "Routines", location: "eos:/routines" },
  { id: "routine", label: "Routine · active", location: `eos:/routines/${routineDetail.routine.id}` },
  { id: "routine-paused", label: "Routine · paused", location: `eos:/routines/${routinePaused.routine.id}` },
  { id: "routine-error", label: "Routine · cannot read", location: `eos:/routines/${routineDetail.routine.id}`, answer: "error" },
  { id: "run", label: "Run", location: `eos:/runs/${runDetail.run.id}` },
  { id: "run-running", label: "Run · working", location: "eos:/runs/rn-running01" },
  { id: "run-waiting", label: "Run · waiting for you", location: "eos:/runs/rn-waiting01" },
  { id: "run-failed", label: "Run · failed", location: "eos:/runs/rn-failed01" },
  { id: "run-queued", label: "Run · queued", location: "eos:/runs/rn-queued01" },
  { id: "memory", label: "Memory", location: "eos:/memory" },
  { id: "memory-note", label: "Memory · a note open", location: `eos:/memory?tab=work&note=${memory.details.find((d) => d.note.text.startsWith("Run lint"))?.note.id ?? memory.details[0].note.id}` },
  { id: "memory-about", label: "Memory · About you", location: "eos:/memory?tab=about" },
  { id: "capabilities", label: "Capabilities", location: "eos:/capabilities" },
  { id: "page", label: "Page · today's issue", location: `eos:/surfaces/${PAPER}` },
  { id: "page-old", label: "Page · an earlier issue", location: `eos:/surfaces/${PAPER}?issue=1` },
  { id: "page-redesign", label: "Page · needs a new design", location: `eos:/surfaces/${PAPER}`, reads: (s) => ({ ...s, [ROUTES.surface(PAPER)]: { ...paper.surface, needsRedesign: { since: 1 } } }) },
  { id: "page-reshape", label: "Page · changing it", location: `eos:/surfaces/${PAPER}?mode=reshape` },
  { id: "page-candidate", label: "Page · a new version to keep", location: `eos:/surfaces/${PAPER}?mode=reshape`, reads: (s) => ({ ...s, [ROUTES.surface(PAPER)]: { ...paper.surface, candidateVersion: 3 } }) },
  { id: "page-empty", label: "Page · no issue yet", location: `eos:/surfaces/${PAPER}`, reads: (s) => ({ ...s, [`${ROUTES.surfaceIssues(PAPER)}?limit=20`]: { issues: [], more: false } }) },
];

export const stateOf = (id) => GALLERY_STATES.find((s) => s.id === id) ?? GALLERY_STATES[0];

// Reads that never answer: every screen shows its loading state.
export const loadingTransport = {
  get: () => new Promise(() => {}),
  send: async () => ({ ok: false, status: 403, body: { error: "sample data" } }),
  upload: async () => ({ ok: false, status: 403, body: { error: "sample data" } }),
};

// Reads the core turns away: every screen shows that it could not read.
export const failingTransport = {
  get: async () => ({ ok: false, status: 500, body: { error: "sample failure" } }),
  send: async () => ({ ok: false, status: 403, body: { error: "sample data" } }),
  upload: async () => ({ ok: false, status: 403, body: { error: "sample data" } }),
};

export const GALLERY_STATE_KEY = "eos:galleryState";

export function storedState() {
  try {
    return sessionStorage.getItem(GALLERY_STATE_KEY);
  } catch {
    return null;
  }
}

export function storeState(id) {
  try {
    sessionStorage.setItem(GALLERY_STATE_KEY, id);
  } catch {}
}
