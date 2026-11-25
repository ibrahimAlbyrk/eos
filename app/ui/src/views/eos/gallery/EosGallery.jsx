import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { rowOf } from "../../../state/eos/capabilitiesStore.js";
import { EosMain } from "../EosMain.jsx";
import { holdEosNavInMemory } from "../nav/eosNav.js";
import { EosSidebarRows } from "../sidebar/EosSidebar.jsx";
import routines from "./sample/routines.json";
import routineDetail from "./sample/routine-detail.json";
import routinePaused from "./sample/routine-paused.json";
import routineDraft from "./sample/routine-draft.json";
import blueprintDrafts from "./sample/blueprint-drafts.json";
import blueprintVersions from "./sample/blueprint-versions.json";
import blueprintVersionBodies from "./sample/blueprint-version-bodies.json";
import runsPage from "./sample/runs-page.json";
import runDetail from "./sample/run-detail.json";
import runs from "./sample/runs.json";
import runResults from "./sample/run-results.json";
import inboxSample from "./sample/inbox.json";
import inboxItemsSample from "./sample/inbox-items.json";
import capabilities from "./sample/capabilities.json";
import signInFailed from "./sample/sign-in-failed.json";
import triggerStatus from "./sample/trigger-status.json";
import signals from "./sample/signals.json";
import memory from "./sample/memory.json";
import surfaceSample from "./sample/surfaces.json";
import paper from "./sample/paper.json";
import { HOME_PROFILE, HOME_SUMMARY, homeNext, homeRuns } from "./sample/home.js";
import { holdHomeInMemory, RUNS_PATH } from "../../../state/eos/homeStore.js";
import { holdHomeDraftInMemory } from "../../../state/eos/homeDraftStore.js";
import { closeField, openField, setTransitionScale } from "../field/fieldStore.js";
import { ENTER_MS } from "../field/transition.js";
import { failingTransport, GALLERY_STATES, loadingTransport, stateOf, storedState, storeState } from "./states.js";

// Needs you's samples moved so the newest arrived twenty minutes before the
// gallery opened, the rest as far before it as recorded: times read "20m ago",
// never a year.
const MIN = 60 * 1000;
const shift = (row, by) => ({ ...row, createdAt: row.createdAt + by, updatedAt: row.updatedAt + by });
const newest = Math.max(...inboxSample.items.map((i) => i.createdAt));
const by = Date.now() - 20 * MIN - newest;
const inbox = { ...inboxSample, items: inboxSample.items.map((i) => shift(i, by)) };
const inboxItems = inboxItemsSample.map((d) => ({ ...d, item: shift(d.item, by) }));

// What the gallery's reads answer, by the path each store asks. The routines
// hold one of each state, PR Review with its detail and runs, Mail Triage
// paused with its detail and an architect's change ready, Docs Review being
// made with its architect asking, and a run of
// PR Review in each state with the results of those shown only; Needs you holds
// an item of each kind; the
// capabilities hold one of each state; GitHub's sign-in is one that did not work.
// PR Review's triggers show a schedule in another zone, a source after a
// catch-up and an open batch, with a signal of each group in its list; Mail
// Triage's source needs a sign-in. Memory holds notes learned for PR Review,
// a project and everywhere, one of them cooling; PR Review's run was given
// four of them. Morning Paper fills a page with three issues in two designs
// and a third version waiting to be kept; it and Build Watch are pinned.
// Home's day is drawn around the moment the gallery opens.
export const SAMPLE_READS = {
  [ROUTES.routines]: routines,
  [ROUTES.routine(routineDetail.routine.id)]: routineDetail,
  [ROUTES.routine(routinePaused.routine.id)]: routinePaused,
  [ROUTES.routine(routineDraft.routine.id)]: routineDraft,
  ...Object.fromEntries(Object.entries(blueprintDrafts).map(([id, draft]) => [ROUTES.routineDraft(id), draft])),
  ...Object.fromEntries(Object.entries(blueprintVersions).map(([id, rows]) => [ROUTES.routineVersions(id), rows])),
  ...Object.fromEntries(Object.entries(blueprintVersionBodies).flatMap(([id, bodies]) => bodies.map((v) => [ROUTES.routineVersion(id, v.id), v]))),
  [`${ROUTES.runs}?routineId=${routineDetail.routine.id}&limit=50`]: runsPage,
  [ROUTES.run(runDetail.run.id)]: runDetail,
  ...Object.fromEntries(runs.map((detail) => [ROUTES.run(detail.run.id), detail])),
  ...Object.fromEntries(runResults.map((result) => [ROUTES.runResult(result.runId), result])),
  [ROUTES.inbox]: inbox,
  ...Object.fromEntries(inboxItems.map((detail) => [ROUTES.inboxItem(detail.item.id), detail])),
  [`${ROUTES.surfaces}?place=needs_you`]: { surfaces: [surfaceSample.surface] },
  [`${ROUTES.surfaceIssues(surfaceSample.surface.id)}?limit=20`]: { issues: [surfaceSample.issue], more: true },
  [ROUTES.surfaceIssue(surfaceSample.surface.id, surfaceSample.issue.id)]: { issue: surfaceSample.issue, body: surfaceSample.body },
  [ROUTES.surface(paper.surface.id)]: paper.surface,
  [`${ROUTES.surfaces}?routine=${paper.surface.routineId}`]: { surfaces: [paper.surface] },
  [`${ROUTES.surfaceIssues(paper.surface.id)}?limit=20`]: paper.issues,
  ...Object.fromEntries(Object.entries(paper.issueBodies).map(([id, one]) => [ROUTES.surfaceIssue(paper.surface.id, id), one])),
  [ROUTES.surfaceVersions(paper.surface.id)]: paper.versions,
  ...Object.fromEntries(Object.entries(paper.versionBodies).map(([n, one]) => [ROUTES.surfaceVersion(paper.surface.id, n), one])),
  [ROUTES.surfacePins]: paper.pins,
  [ROUTES.surfaceTiles]: paper.tiles,
  [ROUTES.capabilities]: capabilities.map(rowOf),
  ...Object.fromEntries(capabilities.map((detail) => [ROUTES.capability(detail.id), detail])),
  [ROUTES.capabilitySignIn("github")]: signInFailed,
  ...Object.fromEntries(Object.entries(triggerStatus).map(([id, status]) => [ROUTES.signalsRoutine(id), status])),
  [`${ROUTES.signals}?routine=${routineDetail.routine.id}`]: signals,
  [ROUTES.memorySummary]: memory.summary,
  [ROUTES.memoryNotes]: memory.notes,
  ...Object.fromEntries(memory.details.map((detail) => [ROUTES.memoryNote(detail.note.id), detail])),
  [`${ROUTES.memoryRecalled}?runId=${memory.recalled.runId}`]: { notes: memory.recalled.notes },
  [ROUTES.profile]: HOME_PROFILE,
  [ROUTES.signalsSummary]: HOME_SUMMARY,
  [RUNS_PATH]: { runs: homeRuns(Date.now()) },
  [ROUTES.signalsRoutines]: homeNext(Date.now()),
};

// Slow plays the transition this many times longer (08 §10).
export const SLOW_K = 2.8;
// How long the field stays open in Play before it leaves again.
const HOLD_MS = 700;

// Plays Home → field → Home once, at `k`.
export function playTransition(k = 1) {
  setTransitionScale(k);
  openField();
  setTimeout(closeField, ENTER_MS * k + HOLD_MS);
}

// The gallery's own bar: which screen and state, and the transition's Play
// and Slow. It sits over Eos and is no part of it.
export function GalleryBar({ current, onPick }) {
  const [slow, setSlow] = useState(false);
  const play = () => {
    const k = slow ? SLOW_K : 1;
    document.querySelector(".eos-mode")?.style.setProperty("--k", String(k));
    playTransition(k);
  };
  return (
    <div className="eos-gallery-bar" role="toolbar" aria-label="Gallery">
      <select className="eos-gallery-bar__state" aria-label="Screen and state" value={current} onChange={(e) => onPick(e.target.value)}>
        {GALLERY_STATES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <button type="button" className="eos-gallery-bar__play" onClick={play}>Play</button>
      <label className="eos-gallery-bar__slow">
        <input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} /> Slow
      </label>
    </div>
  );
}

// Another state: the gallery starts again in it, so every store reads afresh.
function pick(id) {
  storeState(id);
  location.reload();
}

// Eos's columns in the app's grid. The chrome around them (the mode switcher,
// the account footer) reads the core, so the gallery leaves it out.
export function EosGallery({ state = "home" }) {
  return (
    <div className="app eos-mode">
      <GalleryBar current={state} onPick={pick} />
      <aside className="side">
        <div className="side-island side-island--agents"><EosSidebarRows /></div>
      </aside>
      <section className="center"><EosMain /></section>
    </div>
  );
}

// The #eos-gallery page (main.jsx): Eos drawn from sample JSON. It never calls
// the core: every read answers from a sample and every write is refused. It
// opens in the state last picked in this tab (Home at first) and leaves where
// the user's own Eos opens untouched.
// The transport a gallery state reads through.
export function galleryTransport(state) {
  if (state.answer === "loading") return loadingTransport;
  if (state.answer === "error") return failingTransport;
  return fixtureTransport(state.reads ? state.reads(SAMPLE_READS) : SAMPLE_READS);
}

export function startEosGallery(rootEl) {
  const state = stateOf(storedState());
  setEosTransport(galleryTransport(state));
  holdEosNavInMemory(state.location);
  holdHomeInMemory();
  holdHomeDraftInMemory();
  createRoot(rootEl).render(<EosGallery state={state.id} />);
}
