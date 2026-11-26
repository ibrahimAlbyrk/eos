// The gallery's states of what every Eos screen shares: the band that says
// Eos is stopped, on Home and on a routine, and the note once it runs again;
// the menus (a routine's, the sidebar's filter) and pinning a fourth page.
import { ROUTES } from "../../../api/routes.js";
import { notify } from "../../../lib/notify.js";
import routineDetail from "./sample/routine-detail.json";
import paper from "./samplePaper.js";

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

// Home with one pin: Morning Paper alone.
const homeOne = (s) => ({ ...s, [ROUTES.surfacePins]: { surfaceIds: [PAPER] }, [ROUTES.surfaceTiles]: { tiles: [paper.tiles.tiles[0]] } });
// Home with all three places pinned, Morning Paper among them.
const homeThree = (s) => {
  const full = homeFull(s);
  return { ...full, [ROUTES.surfacePins]: { surfaceIds: [PAPER, ...full[ROUTES.surfacePins].surfaceIds.slice(0, 2)] }, [ROUTES.surfaceTiles]: { tiles: [paper.tiles.tiles[0], ...full[ROUTES.surfaceTiles].tiles.slice(0, 2)] } };
};
// PR Review filling Morning Paper's sheet, so its overview shows the page.
const RT = routineDetail.routine.id;
const withPage = (s) => ({ ...s, [`${ROUTES.surfaces}?routine=${RT}`]: { surfaces: [{ ...paper.surface, routineId: RT }] } });
const withNoIssue = (s) => ({ ...withPage(s), [`${ROUTES.surfaceIssues(PAPER)}?limit=20`]: { issues: [], more: false } });

export const CHROME_STATES = [
  { id: "notice", label: "Notice · unpinning refused", location: `eos:/surfaces/${PAPER}`,
    sends: async () => ({ ok: false, status: 500, body: { error: "Eos could not save the pins. Try again in a moment." } }),
    then: pressIn(".eos-head__side button", (b) => b.textContent === "Pinned to Home") },
  { id: "notices", label: "Notice · three at once", location: "eos:/",
    then: () => {
      notify.info("It waits in Needs you for you to send.");
      notify.warning("Slack answered slowly; the channel list may be short.", { title: "Goes to" });
      notify.error("Eos could not export what it learned.", { title: "Settings" });
    } },
  { id: "pins-one", label: "Home · one page pinned", location: "eos:/", reads: homeOne },
  { id: "pins-three", label: "Home · three pinned", location: "eos:/", reads: homeThree },
  { id: "routine-page", label: "Routine · the page it fills", location: `eos:/routines/${RT}`, reads: withPage },
  { id: "routine-page-empty", label: "Routine · its page, no issue yet", location: `eos:/routines/${RT}`, reads: withNoIssue },
  { id: "halt", label: "Eos stopped · on Home", location: "eos:/", reads: stopped },
  { id: "halt-routine", label: "Eos stopped · on a routine", location: `eos:/routines/${routineDetail.routine.id}`, reads: stopped },
  { id: "halt-resumed", label: "Eos stopped · resumed here", location: "eos:/needs", ...resume },
  { id: "menu-routine", label: "Menu · a routine's more", location: `eos:/routines/${routineDetail.routine.id}`, then: pressIn(".eos-head__side button", (b) => b.getAttribute("aria-label")?.startsWith("More for")) },
  { id: "menu-filter", label: "Menu · the sidebar's filter", location: "eos:/", then: pressIn(".eos-side-filter button", () => true) },
  { id: "pin-full", label: "Page · pinning a fourth", location: `eos:/surfaces/${PAPER}`, reads: homeFull,
    sends: async () => ({ ok: false, status: 409, body: { error: "full" } }),
    then: pressIn(".eos-head__side button", (b) => b.textContent === "Pin to Home") },
  { id: "pin-full-picked", label: "Page · pinning a fourth, one picked", location: `eos:/surfaces/${PAPER}`, reads: homeFull,
    sends: async () => ({ ok: false, status: 409, body: { error: "full" } }),
    then: () => {
      pressIn(".eos-head__side button", (b) => b.textContent === "Pin to Home")();
      setTimeout(pressIn(".eos-ask__pick-row", (b) => b.textContent.startsWith("Mail Triage")), 300);
    } },
];
