import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { _resetInbox, refreshInbox } from "../../../state/eos/inboxStore.js";
import { _resetRunSheet, registerHost } from "../../../state/eos/runSheetStore.js";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { EosMain } from "../EosMain.jsx";
import { nextWord, sortRows } from "./tableWords.js";
import { timeAt } from "../routine/words.js";
import routines from "../gallery/sample/routines.json";
import inbox from "../gallery/sample/inbox.json";

const draw = () => renderToStaticMarkup(<EosMain />);
const names = (html) => [...html.matchAll(/<button type="button" class="eos-rtable__name"><span[^>]*><\/span>([^<]*)</g)].map((m) => m[1]);

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
    expect(names(html)).toEqual(["Build Watch", "Morning Paper", "PR Review", "Release Notes"]);
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
