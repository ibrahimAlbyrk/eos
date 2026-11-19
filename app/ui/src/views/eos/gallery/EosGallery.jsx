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
import runsPage from "./sample/runs-page.json";
import runDetail from "./sample/run-detail.json";
import runs from "./sample/runs.json";
import runResults from "./sample/run-results.json";
import inbox from "./sample/inbox.json";
import inboxItems from "./sample/inbox-items.json";
import capabilities from "./sample/capabilities.json";
import signInFailed from "./sample/sign-in-failed.json";

// What the gallery's reads answer, by the path each store asks. The routines
// hold one of each state, PR Review with its detail and runs, Mail Triage
// paused with its detail, and a run of
// PR Review in each state with the results of those shown only; Needs you holds
// an item of each kind; the
// capabilities hold one of each state; GitHub's sign-in is one that did not work.
export const SAMPLE_READS = {
  [ROUTES.routines]: routines,
  [ROUTES.routine(routineDetail.routine.id)]: routineDetail,
  [ROUTES.routine(routinePaused.routine.id)]: routinePaused,
  [`${ROUTES.runs}?routineId=${routineDetail.routine.id}&limit=50`]: runsPage,
  [ROUTES.run(runDetail.run.id)]: runDetail,
  ...Object.fromEntries(runs.map((detail) => [ROUTES.run(detail.run.id), detail])),
  ...Object.fromEntries(runResults.map((result) => [ROUTES.runResult(result.runId), result])),
  [ROUTES.inbox]: inbox,
  ...Object.fromEntries(inboxItems.map((detail) => [ROUTES.inboxItem(detail.item.id), detail])),
  [ROUTES.capabilities]: capabilities.map(rowOf),
  ...Object.fromEntries(capabilities.map((detail) => [ROUTES.capability(detail.id), detail])),
  [ROUTES.capabilitySignIn("github")]: signInFailed,
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
  holdEosNavInMemory("eos:/capabilities");
  createRoot(rootEl).render(<EosGallery />);
}
