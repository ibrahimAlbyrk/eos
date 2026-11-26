// The gallery's states of what every Eos screen shares: the band that says
// Eos is stopped, on Home and on a routine, and the note once it runs again;
// the menus (a routine's, the sidebar's filter) and pinning a fourth page.
import { ROUTES } from "../../../api/routes.js";
import { notify } from "../../../lib/notify.js";
import routineDetail from "./sample/routine-detail.json";
import routines from "./sample/routines.json";
import { APP } from "./appStates.js";
import paper from "./samplePaper.js";

const pressIn = (selector, test) => () => [...document.querySelectorAll(selector)].find(test)?.click();
const PAPER = paper.surface.id;
// Mail Triage's View printed when it paused at 12:51; the changelog kept at 13:50.
const at = (h, m) => new Date().setHours(h, m, 0, 0);
const MAIL_AT = at(12, 51);
const APP_AT = at(13, 50);
// Home holds three pins, none of them Morning Paper; pinning it is refused as full.
const homeFull = (s) => ({
  ...s,
  [ROUTES.surfacePins]: { surfaceIds: ["sf-9q4w2e000001", "sf-mailtriage01", APP] },
  [ROUTES.surfaceTiles]: { tiles: [
    { ...paper.tiles.tiles[1], slot: 0 },
    { slot: 1, surfaceId: "sf-mailtriage01", routineId: "rt-2x8k5n1q6w0r", level: "view", title: "Mail Triage", headline: "Two to answer", detail: "Both from the publisher", issuedAt: MAIL_AT },
    { slot: 2, surfaceId: APP, routineId: "rt-4k2n8q1x7m3p", level: "app", title: "Changelog preview", headline: "v2.4, drafted", detail: "Eleven pull requests since v2.3", issuedAt: APP_AT },
  ] },
});

// Stopped a minute ago, after the last run that works in the samples began.
const SINCE = Date.now() - 60 * 1000;
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
// Morning Paper's own page, so its overview shows the sheet it fills: its
// routine read as the list holds it, with the run that printed issue 3.
const RT = paper.surface.routineId;
const MORNING = routines.find((r) => r.id === RT);
const PRINTED_AT = new Date().setHours(8, 0, 0, 0);
const printed = { ...MORNING.lastRun, createdAt: PRINTED_AT - 2000, startedAt: PRINTED_AT, endedAt: PRINTED_AT + MORNING.lastRun.workMs };
const withPage = (s) => ({
  ...s,
  // Printed at 08:00 and resting until tomorrow's run.
  [ROUTES.routines]: s[ROUTES.routines].map((r) => (r.id === RT ? { ...r, activeRuns: 0 } : r)),
  [ROUTES.routine(RT)]: { ...routineDetail, routine: { ...routineDetail.routine, ...MORNING, activeRuns: 0, stats: undefined }, runs: [printed] },
  [`${ROUTES.surfaces}?routine=${RT}`]: { surfaces: [paper.surface] },
});
const withNoIssue = (s) => ({ ...withPage(s), [`${ROUTES.surfaceIssues(PAPER)}?limit=20`]: { issues: [], more: false } });

export const CHROME_STATES = [
  { id: "notice", label: "Notice · unpinning refused", location: `eos:/surfaces/${PAPER}`,
    sends: async () => ({ ok: false, status: 500, body: { error: "Eos could not save the pins. Try again in a moment." } }),
    then: pressIn(".eos-head__side button", (b) => b.textContent === "Pinned to Home") },
  { id: "notices", label: "Notice · three at once", location: "eos:/",
    then: () => {
      notify.info("It waits in Needs you for you to send.");
      notify.warning("Slack answered slowly; the channel list may be short.", { title: "Goes to" });
      notify.error("Eos could not export what it learned.", { title: "Export failed" });
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
