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
import inbox from "./sample/inbox.json";
import inboxItems from "./sample/inbox-items.json";
import capabilities from "./sample/capabilities.json";
import signInFailed from "./sample/sign-in-failed.json";
import triggerStatus from "./sample/trigger-status.json";
import signals from "./sample/signals.json";
import memory from "./sample/memory.json";
import surfaceSample from "./sample/surfaces.json";
import { HOME_PROFILE, HOME_SUMMARY, homeNext, homeRuns } from "./sample/home.js";
import { holdHomeInMemory, RUNS_PATH } from "../../../state/eos/homeStore.js";
import { holdHomeDraftInMemory } from "../../../state/eos/homeDraftStore.js";

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
// four of them. Home's day is drawn around the moment the gallery opens.
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
  [`${ROUTES.surfaceIssues(surfaceSample.surface.id)}?limit=1`]: { issues: [surfaceSample.issue], more: true },
  [ROUTES.surfaceIssue(surfaceSample.surface.id, surfaceSample.issue.id)]: { issue: surfaceSample.issue, body: surfaceSample.body },
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

// Eos's columns in the app's grid. The chrome around them (the mode switcher,
// the account footer) reads the core, so the gallery leaves it out.
export function EosGallery() {
  return (
    <div className="app eos-mode">
      <aside className="side">
        <div className="side-island side-island--agents"><EosSidebarRows /></div>
      </aside>
      <section className="center"><EosMain /></section>
    </div>
  );
}

// The #eos-gallery page (main.jsx): Eos drawn from sample JSON. It never calls
// the core: every read answers from a sample and every write is refused. It
// opens where Eos opens and leaves where the user's own Eos opens untouched.
export function startEosGallery(rootEl) {
  setEosTransport(fixtureTransport(SAMPLE_READS));
  holdEosNavInMemory("eos:/");
  holdHomeInMemory();
  holdHomeDraftInMemory();
  createRoot(rootEl).render(<EosGallery />);
}
