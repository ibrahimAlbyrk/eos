// The gallery's states (08 §10): each screen in each state it can be in,
// drawn from the samples. A state names where Eos opens and how the reads
// answer: the samples, the samples changed, nothing yet (loading), or a
// refusal (error). Nothing here reaches the core.

import { ROUTES } from "../../../api/routes.js";
import { RUNS_PATH } from "../../../state/eos/homeStore.js";
import inbox from "./sample/inbox.json";
import memory from "./sample/memory.json";
import paper from "./sample/paper.json";
import decision from "./sample/surface-decision.json";
import routineDetail from "./sample/routine-detail.json";
import routineDraft from "./sample/routine-draft.json";
import routinePaused from "./sample/routine-paused.json";
import runDetail from "./sample/run-detail.json";

const PAPER = paper.surface.id;
// Mail Triage's View that asks two things, arrived ten minutes before the
// gallery opened, first in Needs you.
function withDecision(s) {
  const at = Date.now() - 10 * 60 * 1000;
  const item = { ...decision.item, createdAt: at, updatedAt: at };
  const list = s[ROUTES.inbox];
  return { ...s, [ROUTES.inbox]: { ...list, items: [item, ...list.items] }, [ROUTES.inboxItem(item.id)]: { item, payload: {} } };
}

// The same View as a run hands it in without facts or an aside, from a run
// that read outside text.
function withPlainDecision(s) {
  const { facts, aside, ...body } = decision.body; // eslint-disable-line no-unused-vars
  const issue = ROUTES.surfaceIssue(decision.surface.id, decision.issue.id);
  return { ...withDecision(s), [issue]: { issue: decision.issue, body: { ...body, untrusted: true } } };
}

const empty = { ...inbox, items: [], counts: { open: 0, later: 0, byKind: {}, byRoutine: {} } };

// { id, label, location, reads: (samples) → reads, answer?: "loading" | "error" | "offline" }
export const GALLERY_STATES = [
  { id: "home", label: "Home · typical", location: "eos:/" },
  { id: "home-empty", label: "Home · nothing waiting", location: "eos:/", reads: (s) => ({ ...s, [ROUTES.inbox]: empty, [RUNS_PATH]: { runs: [] }, [ROUTES.surfaceTiles]: { tiles: [] } }) },
  { id: "home-first", label: "Home · first run", location: "eos:/", reads: (s) => ({ ...s, [ROUTES.routines]: [], [RUNS_PATH]: { runs: [] }, [ROUTES.inbox]: empty, [ROUTES.signalsRoutines]: [], [ROUTES.surfaceTiles]: { tiles: [] } }) },
  { id: "home-loading", label: "Home · loading", location: "eos:/", answer: "loading" },
  { id: "home-error", label: "Home · cannot read", location: "eos:/", answer: "error" },
  { id: "home-offline", label: "Home · reconnecting", location: "eos:/", answer: "offline" },
  { id: "needs", label: "Needs you", location: "eos:/needs" },
  { id: "needs-empty", label: "Needs you · empty", location: "eos:/needs", reads: (s) => ({ ...s, [ROUTES.inbox]: empty }) },
  { id: "need", label: "Needs you · a draft", location: `eos:/needs/${inbox.items.find((i) => i.kind === "draft")?.id}` },
  { id: "need-offline", label: "Needs you · a draft, reconnecting", location: `eos:/needs/${inbox.items.find((i) => i.kind === "draft")?.id}`, answer: "offline" },
  { id: "need-view", label: "Needs you · a View that asks", location: `eos:/needs/${decision.item.id}`, reads: withDecision },
  { id: "need-view-plain", label: "Needs you · a View with no facts or aside, from outside text", location: `eos:/needs/${decision.item.id}`, reads: withPlainDecision },
  { id: "link", label: "A link wants to start a run", location: "eos:/form?routine=pr-review&item=%23470&opt.depth=deep&showOnly=1&from=link" },
  { id: "routines", label: "Routines", location: "eos:/routines" },
  { id: "routines-empty", label: "Routines · none yet", location: "eos:/routines", reads: (s) => ({ ...s, [ROUTES.routines]: [] }) },
  { id: "routine", label: "Routine · active", location: `eos:/routines/${routineDetail.routine.id}` },
  { id: "routine-paused", label: "Routine · paused", location: `eos:/routines/${routinePaused.routine.id}` },
  { id: "routine-making", label: "Routine · being made, the architect asking", location: `eos:/routines/${routineDraft.routine.id}?tab=blueprint` },
  { id: "routine-change", label: "Routine · a change to look at", location: `eos:/routines/${routinePaused.routine.id}?tab=blueprint` },
  { id: "new-routine", label: "New routine", location: "eos:/routines/new" },
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

// Reads the core answers once and then stops answering: every screen first
// draws the samples, then shows that it is reconnecting when it reads again.
export function offlineTransport(answering) {
  const asked = new Set();
  return {
    get: (path) => {
      if (asked.has(path)) return Promise.reject(new Error("no answer"));
      asked.add(path);
      return answering.get(path);
    },
    send: () => Promise.reject(new Error("no answer")),
    upload: () => Promise.reject(new Error("no answer")),
  };
}

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
