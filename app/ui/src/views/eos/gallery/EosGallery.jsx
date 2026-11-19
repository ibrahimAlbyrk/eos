import { createRoot } from "react-dom/client";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { rowOf } from "../../../state/eos/capabilitiesStore.js";
import { EosMain } from "../EosMain.jsx";
import { holdEosNavInMemory } from "../nav/eosNav.js";
import { EosSidebarRows } from "../sidebar/EosSidebar.jsx";
import routines from "./sample/routines.json";
import routineDetail from "./sample/routine-detail.json";
import runsPage from "./sample/runs-page.json";
import runDetail from "./sample/run-detail.json";
import inbox from "./sample/inbox.json";
import capabilities from "./sample/capabilities.json";
import signInFailed from "./sample/sign-in-failed.json";

// What the gallery's reads answer, by the path each store asks. The routines
// hold one of each state, PR Review with its detail and runs; the
// capabilities hold one of each state; GitHub's sign-in is one that did not work.
export const SAMPLE_READS = {
  [ROUTES.routines]: routines,
  [ROUTES.routine(routineDetail.routine.id)]: routineDetail,
  [`${ROUTES.runs}?routineId=${routineDetail.routine.id}&limit=50`]: runsPage,
  [ROUTES.run(runDetail.run.id)]: runDetail,
  [ROUTES.inbox]: inbox,
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
