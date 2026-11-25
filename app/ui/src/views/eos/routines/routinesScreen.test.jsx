import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { _resetInbox, refreshInbox } from "../../../state/eos/inboxStore.js";
import { _resetRunSheet, registerHost } from "../../../state/eos/runSheetStore.js";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { EosMain } from "../EosMain.jsx";
import { nextWord, routinesLead, soonestLine, sortRows } from "./tableWords.js";
import { timeAt } from "../routine/words.js";
import routines from "../gallery/sample/routines.json";
import inbox from "../gallery/sample/inbox.json";

const draw = () => renderToStaticMarkup(<EosMain />);
const names = (html) => [...html.matchAll(/<span class="eos-rtable__title">([^<]*)</g)].map((m) => m[1]);
const groups = (html) => [...html.matchAll(/<th scope="colgroup" colSpan="9"><span class="eos-label">([^<]*)<\/span><span class="eos-section__aside">(\d+)</g)].map((m) => `${m[1]} ${m[2]}`);

beforeEach(async () => {
  _resetRoutines();
  _resetInbox();
  _resetRunSheet();
  _resetEosNav();
  setEosTransport(fixtureTransport({ [ROUTES.routines]: routines, [ROUTES.inbox]: inbox }));
  await refreshRoutines();
  await refreshInbox();
  openLocation("eos:/routines");
});
afterEach(() => setEosTransport(null));

describe("all routines", () => {
  it("is a table of the active routines by name, each with what it waits on, its week's cost and its freedom", () => {
    const html = draw();
    expect(html).not.toContain("This part of Eos is not here yet.");
    expect(html).toContain('<h1 class="eos-title">Routines</h1>');
    // Grouped by what the user must do, by name within each group.
    expect(groups(html)).toEqual(["Waiting for you 2", "On their own 1", "Being made 1"]);
    expect(names(html)).toEqual(["Morning Paper", "PR Review", "Build Watch", "Release Notes"]);
    expect(html).toContain('<span class="eos-rtable__mark eos-rtable__mark--active" aria-hidden="true"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" class="eos-rtable__glyph">');
    expect(html).toContain('<span class="eos-rtable__summary">Reviews each new pull request and drafts a review for you to send.</span>');
    expect(html).toContain('<th scope="col" aria-sort="ascending"><button type="button" class="eos-rtable__sort">Routine<span aria-hidden="true"> ↑</span></button></th>');
    const pr = html.split("<tr>").find((row) => row.includes(">PR Review<"));
    expect(pr).toContain("3 waiting");
    expect(pr).toContain("$2.84");
    expect(pr).toContain("Draft, I send");
    expect(pr).toContain("Done");
  });

  it("offers Run on each routine that can run once a run sheet is hosted, never on one being made", () => {
    expect(draw()).not.toContain('aria-label="Run PR Review"');
    registerHost();
    const html = draw();
    expect(html).toContain('aria-label="Run PR Review"');
    expect(html).not.toContain('aria-label="Run Release Notes"');
  });

  it("sorts by any column, a routine without a value last either way", () => {
    const rows = [
      { routine: { name: "B" }, nextAt: 20 },
      { routine: { name: "A" } },
      { routine: { name: "C" }, nextAt: 10 },
    ];
    expect(sortRows(rows, "next", "ascending").map((r) => r.routine.name)).toEqual(["C", "B", "A"]);
    expect(sortRows(rows, "next", "descending").map((r) => r.routine.name)).toEqual(["B", "C", "A"]);
    expect(sortRows(rows, "name", "descending").map((r) => r.routine.name)).toEqual(["C", "B", "A"]);
  });

  it("leads with how many routines there are and how many wait, then the soonest run", () => {
    const html = draw();
    expect(html).toContain('<p class="eos-lead">Four routines, two of them waiting for you.</p>');
    expect(html).not.toContain("eos-card eos-rtable-wrap");
    const r = (name, waiting, nextAt) => ({ routine: { name }, waiting, nextAt });
    expect(routinesLead([r("A", 0)])).toBe("One routine.");
    expect(routinesLead([r("A", 2)])).toBe("One routine, waiting for you.");
    expect(routinesLead([r("A", 1), r("B", 3)])).toBe("Two routines, all waiting for you.");
    const now = new Date(2026, 10, 25, 9, 0).getTime();
    expect(soonestLine([r("A", 0, now + 7200_000), r("B", 0, now + 3600_000), r("C", 0)], now)).toBe("Next: B, today 10:00.");
    expect(soonestLine([r("C", 0)], now)).toBeNull();
  });

  it("says what routines are for when there are none, with the way to make one", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.routines]: [], [ROUTES.inbox]: inbox }));
    await refreshRoutines();
    const html = draw();
    expect(html).toContain('<p class="eos-empty__title">No routines yet.</p>');
    expect(html).toContain(">Make the first one</button>");
    expect(html).not.toContain("eos-lead");
    expect(html).not.toContain("eos-seg");
  });

  it("says the next run by its day", () => {
    const now = new Date(2026, 10, 25, 9, 0).getTime();
    expect(nextWord(new Date(2026, 10, 25, 14, 30).getTime(), now)).toMatch(/^Today /);
    expect(nextWord(new Date(2026, 10, 26, 7, 30).getTime(), now)).toMatch(/^Tomorrow /);
    expect(nextWord(undefined, now)).toBeNull();
    // Eos says times on a 24-hour clock, as its designs and the core's own
    // lines ("weekdays at 05:00") do, whatever the locale.
    expect(nextWord(new Date(2026, 10, 25, 14, 30).getTime(), now)).toMatch(/^Today 14:30$/);
    expect(timeAt(new Date(2026, 10, 26, 15, 5).getTime())).toMatch(/ 15:05$/);
  });
});
