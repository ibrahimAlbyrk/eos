import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport, transport } from "../../../state/eos/transport.js";
import { _resetRoutines, deleteRoutine, refreshRoutines, undeleteRoutine } from "../../../state/eos/routinesStore.js";
import { _resetInbox, refreshInbox } from "../../../state/eos/inboxStore.js";
import { _resetRunSheet, registerHost, useRunSheet } from "../../../state/eos/runSheetStore.js";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { EosSidebarRows } from "./EosSidebar.jsx";
import { RoutineRunButton } from "./RoutineRunButton.jsx";
import routines from "../gallery/sample/routines.json";
import inbox from "../gallery/sample/inbox.json";

const DEV_RUN_TEXT = "This is a dev run: nothing starts or leaves the Mac.";
const byName = Object.fromEntries(routines.map((r) => [r.name, r]));

function stubStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

async function load(reads) {
  setEosTransport(fixtureTransport(reads));
  await refreshRoutines();
  await refreshInbox();
}

const draw = () => renderToStaticMarkup(<EosSidebarRows />);

// The names of the routine rows, in order.
const names = (html) => [...html.matchAll(/<span class="ag-name">([^<]*)</g)].map((m) => m[1].replace("&amp;", "&"));

// One routine's row.
const rowOf = (html, name) => html.split('<li class="eos-side-routine">').find((part) => part.includes(`ag-name">${name}<`));

beforeEach(() => {
  _resetRoutines();
  _resetInbox();
  _resetRunSheet();
  _resetEosNav();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("the Eos sidebar's nav rows", () => {
  it("lead to New routine, Home, Needs you with its open count, Routines, Memory and Capabilities", async () => {
    await load({ [ROUTES.routines]: routines, [ROUTES.inbox]: inbox });
    openLocation("eos:/needs");
    const html = draw();
    const labels = [...html.matchAll(/<span class="sb-nav-row__label">([^<]*)</g)].map((m) => m[1]);
    expect(labels).toEqual(["New routine", "Home", "Needs you", "Routines", "Memory", "Capabilities"]);
    expect(html).toContain('<span class="sb-nav-row__meta">⌘N</span>');
    expect(html).toContain('<span class="sb-nav-row__label">Needs you</span><span class="sb-nav-row__meta"><span class="eos-badge">5<span class="eos-sr"> waiting</span></span></span>');
    expect(html).toContain('<button class="sb-nav-row strong on"><span class="sb-nav-row__ic">');
    expect(html.match(/sb-nav-row strong on/g)).toHaveLength(1);
  });

  it("show no badge while nothing waits or Needs you has not loaded", async () => {
    expect(draw()).not.toContain("eos-badge");
    await load({ [ROUTES.routines]: [], [ROUTES.inbox]: { ...inbox, items: [], counts: { open: 0, later: 0, byKind: {}, byRoutine: {} } } });
    expect(draw()).not.toContain("eos-badge");
  });
});

describe("the routine rows", () => {
  it("show the active routines, and a paused one with something waiting, each with its status in words beside its dot", async () => {
    await load({ [ROUTES.routines]: routines, [ROUTES.inbox]: inbox });
    const html = draw();
    expect(names(html)).toEqual(["PR Review", "Morning Paper", "Mail Triage", "Build Watch", "Release Notes"]);
    const expected = {
      "PR Review": ["eos-side-dot--active", '<span class="eos-side-line eos-side-line--active">3 waiting</span>'],
      // Its one item was put off for Later: nothing of it waits now.
      "Morning Paper": ["eos-side-dot--ok", '<span class="eos-side-line">Every day at 08:00</span>'],
      "Mail Triage": ["eos-side-dot--warn", '<span class="eos-side-line eos-side-line--warn">Paused, 1 waiting</span>'],
      "Build Watch": ["eos-side-dot--ok", '<span class="eos-side-line">Every 30 minutes</span>'],
      "Release Notes": ['class="eos-side-dot"', '<span class="eos-side-line">Being made</span>'],
    };
    for (const [name, [dot, line]] of Object.entries(expected)) {
      const row = rowOf(html, name);
      expect(row, name).toContain(dot);
      expect(row, name).toContain(line);
    }
    expect(html).toContain('<span class="sb-seclabel__text">Routines</span>');
    expect(html).toContain('<button type="button" class="sb-seclabel__filter" aria-label="Filter routines" title="Filter routines" aria-haspopup="menu" aria-expanded="false">');
  });

  it("show the paused and archived routines under their filter, kept from the last time", async () => {
    await load({ [ROUTES.routines]: routines, [ROUTES.inbox]: inbox });
    localStorage.setItem("eos:sidebarFilter", "paused");
    let html = draw();
    expect(names(html)).toEqual(["Mail Triage"]);
    expect(rowOf(html, "Mail Triage")).toContain('<span class="eos-side-dot eos-side-dot--warn" aria-hidden="true"></span>');
    expect(rowOf(html, "Mail Triage")).toContain('<span class="eos-side-line eos-side-line--warn">Paused, 1 waiting</span>');
    expect(html).toContain('Routines<span class="eos-side-filter__name"> · Paused</span>');
    expect(html).toContain('<button type="button" class="sb-seclabel__filter on" aria-label="Filter routines"');

    localStorage.setItem("eos:sidebarFilter", "archived");
    html = draw();
    expect(names(html)).toEqual(["Weekly Report"]);
    expect(rowOf(html, "Weekly Report")).toContain('<span class="eos-side-line">Archived</span>');

    localStorage.setItem("eos:sidebarFilter", "something else");
    expect(names(draw())).toEqual(["PR Review", "Morning Paper", "Mail Triage", "Build Watch", "Release Notes"]);
  });

  it("keep a deleted routine under Deleted for 30 days, and Bring back puts it where it was", async () => {
    const paper = byName["Morning Paper"];
    await load({ [ROUTES.routines]: routines, [ROUTES.inbox]: inbox });
    const back = { ...paper, state: "paused", pausedReason: "user" };
    const sent = [];
    setEosTransport({
      ...transport,
      send: async (method, path) => {
        sent.push([method, path]);
        return { ok: true, status: 200, body: method === "POST" ? back : {} };
      },
    });
    expect(await deleteRoutine(paper.id)).toBe(true);
    expect(names(draw())).not.toContain("Morning Paper");
    localStorage.setItem("eos:sidebarFilter", "deleted");
    const html = draw();
    expect(names(html)).toEqual(["Morning Paper"]);
    expect(rowOf(html, "Morning Paper")).toContain('<span class="eos-side-line">Deleted</span>');
    expect(rowOf(html, "Morning Paper")).toContain('<button type="button" class="eos-btn">Bring back</button>');
    expect(rowOf(html, "Morning Paper")).not.toContain("Run ");

    expect(await undeleteRoutine(paper.id)).toBe(true);
    expect(sent).toEqual([["DELETE", ROUTES.routine(paper.id)], ["POST", ROUTES.routineUndelete(paper.id)]]);
    expect(draw()).toContain('<p class="eos-side-note">Nothing was deleted in the last 30 days.</p>');
    localStorage.setItem("eos:sidebarFilter", "paused");
    expect(names(draw())).toContain("Morning Paper");
  });

  it("say a running routine, a failed last run and a routine run only by hand in words", async () => {
    const failed = { ...byName["Mail Triage"], state: "active" };
    const byHand = { ...byName["Build Watch"], triggerLine: undefined };
    await load({ [ROUTES.routines]: [failed, byHand, { ...byName["Morning Paper"], activeRuns: 1 }], [ROUTES.inbox]: { ...inbox, counts: { ...inbox.counts, byRoutine: {} } } });
    const html = draw();
    expect(rowOf(html, "Morning Paper")).toContain('<span class="eos-side-dot eos-side-dot--ok" aria-hidden="true"></span>');
    expect(rowOf(html, "Morning Paper")).toContain('<span class="eos-side-line">Running</span>');
    expect(rowOf(html, "Mail Triage")).toContain('<span class="eos-side-line eos-side-line--err">Last run failed</span>');
    expect(rowOf(html, "Build Watch")).toContain('<span class="eos-side-line">When you run it</span>');
  });

  it("say a trigger too long for the row's slot as waiting for it", async () => {
    const long = { ...byName["Build Watch"], triggerLine: "When a pull request opens" };
    await load({ [ROUTES.routines]: [long], [ROUTES.inbox]: { ...inbox, counts: { ...inbox.counts, byRoutine: {} } } });
    expect(rowOf(draw(), "Build Watch")).toContain('<span class="eos-side-line">On its trigger</span>');
  });

  it("say when there are none, for each filter", async () => {
    await load({ [ROUTES.routines]: [], [ROUTES.inbox]: inbox });
    expect(draw()).toContain('<p class="eos-side-note">No routines yet.<span class="eos-side-note__more">');
    await load({ [ROUTES.routines]: [{ ...routines[0], state: "paused" }], [ROUTES.inbox]: { ...inbox, counts: { ...inbox.counts, byRoutine: {} } } });
    expect(draw()).toContain('Every routine is paused. <button type="button" class="eos-link">Show paused</button>');
    localStorage.setItem("eos:sidebarFilter", "archived");
    await load({ [ROUTES.routines]: [routines[0]], [ROUTES.inbox]: inbox });
    expect(draw()).toContain('<p class="eos-side-note">No archived routines.</p>');
  });

  it("show ghost rows while loading, and a failed read in words with Try again", async () => {
    let html = draw();
    expect(html).not.toContain("eos-side-note");
    expect(html).toContain('aria-label="Loading routines"');
    expect(names(html)).toEqual([]);
    await load({});
    html = draw();
    expect(html).toContain("Couldn&#x27;t load routines. <button type=\"button\" class=\"eos-link\">Try again</button>");
  });

  it("draw many routines, every one", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...routines[3], id: `rt-${String(i).padStart(12, "0")}`, name: `Routine ${i + 1}` }));
    await load({ [ROUTES.routines]: many, [ROUTES.inbox]: inbox });
    expect(names(draw())).toHaveLength(40);
  });

  it("mark the routine open in Eos", async () => {
    await load({ [ROUTES.routines]: routines, [ROUTES.inbox]: inbox });
    openLocation(`eos:/routines/${byName["Build Watch"].id}`);
    const html = draw();
    expect(rowOf(html, "Build Watch")).toContain('class="agents-row eos-side-routine__open on" aria-current="page"');
    expect(rowOf(html, "PR Review")).not.toContain("aria-current");
  });

  it("say this is a dev run once a write was refused for it", async () => {
    await load({ [ROUTES.routines]: routines, [ROUTES.inbox]: inbox });
    expect(draw()).not.toContain(DEV_RUN_TEXT);
    setEosTransport({
      get: async () => ({ ok: false, status: 404, body: {} }),
      send: async () => ({ ok: false, status: 403, body: { error: "refused in a dev run: this request can start an agent" } }),
    });
    await transport.send("POST", ROUTES.runs, {});
    expect(draw()).toContain(`<p class="eos-note" role="status">${DEV_RUN_TEXT}</p>`);
  });
});

describe("the Run button", () => {
  it("is hidden until a run sheet is hosted, then shows on active and paused routines", async () => {
    await load({ [ROUTES.routines]: routines, [ROUTES.inbox]: inbox });
    expect(draw()).not.toContain("eos-side-run");

    registerHost();
    let html = draw();
    expect(rowOf(html, "PR Review")).toContain('<button type="button" class="eos-side-run" aria-label="Run PR Review" title="Run PR Review">');
    expect(rowOf(html, "Release Notes")).not.toContain("eos-side-run");
    localStorage.setItem("eos:sidebarFilter", "paused");
    html = draw();
    expect(rowOf(html, "Mail Triage")).toContain('aria-label="Run Mail Triage"');
    localStorage.setItem("eos:sidebarFilter", "archived");
    expect(draw()).not.toContain("eos-side-run");
  });

  it("opens the sheet for its routine beside itself", () => {
    registerHost();
    let button;
    let sheet;
    function Probe() {
      button = RoutineRunButton({ routine: routines[0] });
      sheet = useRunSheet();
      return button;
    }
    renderToStaticMarkup(<Probe />);
    const anchor = { tagName: "BUTTON" };
    button.props.onClick({ currentTarget: anchor });
    renderToStaticMarkup(<Probe />);
    expect(sheet.request).toEqual({ routineId: routines[0].id, anchor });
  });
});
