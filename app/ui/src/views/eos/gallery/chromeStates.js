// The gallery's states of what every Eos screen shares: the band that says
// Eos is stopped, on Home and on a routine, and the note once it runs again.
import { ROUTES } from "../../../api/routes.js";
import routineDetail from "./sample/routine-detail.json";

const SINCE = Date.now() - 42 * 60 * 1000;
const stopped = (s) => ({ ...s, [ROUTES.eosHalt]: { on: true, since: SINCE } });
const resume = {
  reads: stopped,
  sends: async (method, path) => (path === ROUTES.eosResume
    ? { ok: true, status: 200, body: { on: false } }
    : { ok: false, status: 403, body: { error: "sample data" } }),
  then: () => [...document.querySelectorAll(".eos-halt button")].find((b) => b.textContent === "Resume")?.click(),
};

export const CHROME_STATES = [
  { id: "halt", label: "Eos stopped · on Home", location: "eos:/", reads: stopped },
  { id: "halt-routine", label: "Eos stopped · on a routine", location: `eos:/routines/${routineDetail.routine.id}`, reads: stopped },
  { id: "halt-resumed", label: "Eos stopped · resumed here", location: "eos:/needs", ...resume },
];
