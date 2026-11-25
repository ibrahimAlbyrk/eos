// The gallery's states of what every Eos screen shares: the band that says
// Eos is stopped, on Home and on a routine, and the note once it runs again;
// the menus (a routine's, the sidebar's filter) and pinning a fourth page.
import { ROUTES } from "../../../api/routes.js";
import routineDetail from "./sample/routine-detail.json";
import paper from "./sample/paper.json";

const pressIn = (selector, test) => () => [...document.querySelectorAll(selector)].find(test)?.click();
const PAPER = paper.surface.id;
// Home holds three pins, none of them Morning Paper; pinning it is refused as full.
const homeFull = (s) => ({
  ...s,
  [ROUTES.surfacePins]: { surfaceIds: ["sf-9q4w2e000001", "sf-mailtriage01", "sf-release0001"] },
  [ROUTES.surfaceTiles]: { tiles: [
    { ...paper.tiles.tiles[1], slot: 0 },
    { slot: 1, surfaceId: "sf-mailtriage01", routineId: "rt-mail", level: "view", title: "Mail Triage", headline: "Two to answer" },
    { slot: 2, surfaceId: "sf-release0001", routineId: "rt-release", level: "page", title: "Release Notes", headline: "v2.4 drafted" },
  ] },
});

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
  { id: "menu-routine", label: "Menu · a routine's more", location: `eos:/routines/${routineDetail.routine.id}`, then: pressIn(".eos-head__side button", (b) => b.getAttribute("aria-label")?.startsWith("More for")) },
  { id: "menu-filter", label: "Menu · the sidebar's filter", location: "eos:/", then: pressIn(".eos-side-filter button", () => true) },
  { id: "pin-full", label: "Page · pinning a fourth", location: `eos:/surfaces/${PAPER}`, reads: homeFull,
    sends: async () => ({ ok: false, status: 409, body: { error: "full" } }),
    then: pressIn(".eos-head__side button", (b) => b.textContent === "Pin to Home") },
];
