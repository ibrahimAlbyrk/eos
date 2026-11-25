import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetInbox, refreshInbox } from "../../../state/eos/inboxStore.js";
import { _resetRoutines, loadRoutine, refreshRoutines, setRoutineState, useRoutines } from "../../../state/eos/routinesStore.js";
import { _resetRuns, loadRun, loadRuns } from "../../../state/eos/runsStore.js";
import { _resetRunSheet, registerHost } from "../../../state/eos/runSheetStore.js";
import { _resetSurfaces, loadRoutineView } from "../../../state/eos/surfacesStore.js";
import { UiProvider } from "../../../state/ui.jsx";
import { EosMain } from "../EosMain.jsx";
import { _resetEosNav, eosLocation, openLocation } from "../nav/eosNav.js";
import { fileName, menuActions } from "./RoutineMenu.jsx";
import { pausedLine } from "./words.js";
import routines from "../gallery/sample/routines.json";
import routineDetail from "../gallery/sample/routine-detail.json";
import routinePaused from "../gallery/sample/routine-paused.json";
import runsPage from "../gallery/sample/runs-page.json";
import runs from "../gallery/sample/runs.json";
import inbox from "../gallery/sample/inbox.json";

vi.mock("../../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));
vi.mock("../../../api/client.js", () => ({ api: { setStreamFocus: async () => ({ ok: true, body: { live: [] } }) } }));

const PR = routineDetail.routine.id;
const MAIL = routinePaused.routine.id;
const DEV_RUN_TEXT = "This is a dev run: nothing starts or leaves the Mac.";
const reads = {
  [ROUTES.routines]: routines,
  [ROUTES.inbox]: inbox,
  [ROUTES.routine(PR)]: routineDetail,
  [ROUTES.routine(MAIL)]: routinePaused,
  [`${ROUTES.runs}?routineId=${PR}&limit=50`]: runsPage,
};

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

function recording(sent = async () => ({ ok: true, status: 200, body: {} }), paths = reads) {
  const fixture = fixtureTransport(paths);
  return { get: vi.fn(fixture.get), send: vi.fn(sent) };
}

async function page(location, transport = fixtureTransport(reads)) {
  setEosTransport(transport);
  await refreshRoutines();
  await refreshInbox();
  const id = decodeURIComponent(location.split("/")[2].split("?")[0]);
  await loadRoutine(id);
  openLocation(location);
  return renderToStaticMarkup(<EosMain />);
}

const draw = () => renderToStaticMarkup(<EosMain />);
const tabs = (html) => [...html.matchAll(/aria-selected="(true|false)"[^>]*>([^<]*)</g)].map((m) => `${m[2]}${m[1] === "true" ? "*" : ""}`);

function rowState(id) {
  let read;
  function Probe() {
    read = useRoutines();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read.details[id]?.routine.state;
}

beforeEach(() => {
  globalThis.localStorage = stubStorage();
  _resetRoutines();
  _resetRuns();
  _resetInbox();
  _resetRunSheet();
  _resetSurfaces();
  _resetEosNav();
});
afterEach(() => {
  delete globalThis.localStorage;
  setEosTransport(null);
});

describe("the routine page", () => {
  it("heads the routine with its status, Pause, Change it and its menu; Run now once a sheet is hosted", async () => {
    let html = await page(`eos:/routines/${PR}`);
    expect(html).toContain('<button type="button" class="eos-crumb">Routines</button>');
    expect(html).toContain('<h1 class="eos-title">PR Review</h1>');
    expect(html).toContain('<h1 class="eos-title">PR Review</h1><div class="eos-head__side"><span class="eos-status eos-status--active">3 waiting</span>');
    expect(html).toContain(">Pause</button>");
    expect(html).toContain(">Change it</button>");
    expect(html).toContain('aria-haspopup="menu" aria-expanded="false" aria-label="More for PR Review">⋯</button>');
    expect(html).not.toContain("Run now");

    registerHost();
    html = draw();
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Run now</button>');
  });

  it("says what starts the routine under its summary, and no longer that triggers wait", async () => {
    const html = await page(`eos:/routines/${PR}`);
    expect(html).toContain('<p class="eos-routine__summary">Reviews each new pull request and drafts a review for you to send.</p>');
    expect(html).toContain('<p class="eos-routine__line">When a pull request opens in acme/game</p>');
    expect(html).not.toContain("Runs when you start it");
  });

  it("shows Overview first: nothing running, the recent runs, and no Getting better without stats", async () => {
    const html = await page(`eos:/routines/${PR}`);
    expect(tabs(html)).toEqual(["Overview*", "Runs", "Signals", "Blueprint"]);
    expect(html).not.toContain("Learned");
    expect(html).toContain("Nothing is running.");
    expect(html).toContain('<span class="eos-run-row__title">Fix the login</span>');
    expect(html).not.toContain("Getting better");
  });

  it("shows on Overview the View its newest real run returned, in Eos's frame, past a newer trial", async () => {
    const surface = { id: "sf-1", routineId: PR, level: "view", place: "needs_you", role: "result", title: "PR Review" };
    const issue = (id, trial) => ({ id, surfaceId: "sf-1", seq: trial ? null : 2, kind: "view", status: "ready", rev: 1, trial, createdAt: 1795000000000 });
    const view = { title: "Reviews today", summary: "Two reviews.", ui: "<Text>Two reviews went out.</Text>", actions: {} };
    const withView = {
      ...reads,
      [`${ROUTES.surfaces}?routine=${PR}`]: { surfaces: [surface] },
      [`${ROUTES.surfaceIssues("sf-1")}?limit=20`]: { issues: [issue("si-trial", true), issue("si-2", false)], more: false },
      [ROUTES.surfaceIssue("sf-1", "si-2")]: { issue: issue("si-2", false), body: { view, actions: [] } },
    };
    setEosTransport(fixtureTransport(withView));
    await refreshRoutines();
    await loadRoutine(PR);
    await loadRoutineView(PR);
    openLocation(`eos:/routines/${PR}`);
    // A View is drawn inside the app's providers, as Needs you draws it.
    const inApp = () => renderToStaticMarkup(<UiProvider><EosMain /></UiProvider>);
    let html = inApp();
    expect(html).toContain('<section class="eos-routine__section" aria-label="What it made last"><section class="eos-frame" aria-label="Made by PR Review">');
    expect(html).toContain("Reviews today");
    openLocation(`eos:/routines/${PR}?tab=runs`);
    expect(inApp()).not.toContain("What it made last");
    await loadRoutineView(MAIL);
    html = await page(`eos:/routines/${MAIL}`);
    expect(html).not.toContain("What it made last");
  });

  it("shows the runs that work right now and how the routine gets better once its row carries stats", async () => {
    const live = runs.find((d) => d.run.state === "running").run;
    const withStats = {
      ...routineDetail,
      routine: { ...routineDetail.routine, stats: { sentUnedited7d: 0.86, baselineFirstWeek: 0.4, runs7d: 7, cost7d: 2.1, setupUsd: 0.5 } },
      runs: [live, ...routineDetail.runs],
    };
    const html = await page(`eos:/routines/${PR}`, fixtureTransport({ ...reads, [ROUTES.routine(PR)]: withStats }));
    const now = html.slice(html.indexOf("Right now"), html.indexOf("Recent runs"));
    expect(now).toContain("#470 Rework shop carousel paging");
    expect(now).toContain(">Open the run</button>");
    expect(now).not.toContain("Fix the login");
    expect(html).toContain('<h2 class="eos-label">Getting better</h2><p class="eos-better__share">86% sent without a single edit this week</p><p class="eos-better__base">First week, 40%</p>');
  });

  it("lists every run on the Runs tab with a filter by origin, and the blueprint's slots on the Blueprint tab", async () => {
    setEosTransport(fixtureTransport(reads));
    await loadRuns(PR);
    const runsTab = await page(`eos:/routines/${PR}?tab=runs`);
    expect(tabs(runsTab)).toEqual(["Overview", "Runs*", "Signals", "Blueprint"]);
    expect(runsTab).toContain('<span class="eos-run-row__title">Fix the login</span>');

    const mixed = { runs: [...runsPage.runs, { ...runsPage.runs[0], id: "rn-hand", origin: "hand" }] };
    setEosTransport(fixtureTransport({ ...reads, [`${ROUTES.runs}?routineId=${PR}&limit=50`]: mixed }));
    await loadRuns(PR);
    expect(draw()).toContain('role="radiogroup" aria-label="Show runs"');
    expect([...draw().matchAll(/role="radio" aria-checked="(?:true|false)" class="eos-seg__opt">([^<]*)</g)].map((m) => m[1])).toEqual(["All", "Triggered", "By hand"]);

    const blueprint = await page(`eos:/routines/${MAIL}?tab=blueprint`);
    expect(tabs(blueprint)).toEqual(["Overview", "Runs", "Signals", "Blueprint*"]);
    expect(blueprint).toContain('aria-label="Conversation with the architect"');
    expect([...blueprint.matchAll(/<dt class="eos-bp-row__label">([^<]*)</g)].map((m) => m[1])).toEqual(["Takes", "When", "Which", "Who", "How", "Makes", "Goes to", "Freedom"]);
    expect(blueprint).not.toContain("Runs when you start it");
  });

  it("shows Overview for the Learned tab, which waits for Memory", async () => {
    expect(tabs(await page(`eos:/routines/${PR}?tab=learned`))).toEqual(["Overview*", "Runs", "Signals", "Blueprint"]);
  });

  it("bands a paused routine with its reason in words, Resume and its last run", async () => {
    const html = await page(`eos:/routines/${MAIL}`);
    expect(html).toContain('<span class="eos-status eos-status--warn">Paused</span>');
    expect(html).toContain('<div class="eos-band eos-band--warn" role="status"><span class="eos-band__text">Paused after three failed runs in a row.</span>');
    expect(html).toContain('<button type="button" class="eos-btn eos-btn--primary">Resume</button>');
    expect(html).toContain(">Open the last run</button>");
    expect(html).not.toContain(">Pause</button>");
  });

  it("names the capability a routine waits for", () => {
    expect(pausedLine("capability:notes-db")).toBe("Paused until notes-db works again.");
    expect(pausedLine("odd")).toBe("Paused.");
  });

  it("bands a routine whose last run failed with the reason in words", async () => {
    const failing = { ...routinePaused, routine: { ...routinePaused.routine, state: "active", pausedReason: undefined } };
    const nothingWaits = { ...inbox, items: [], counts: { ...inbox.counts, byRoutine: {} } };
    const html = await page(`eos:/routines/${MAIL}`, fixtureTransport({ ...reads, [ROUTES.inbox]: nothingWaits, [ROUTES.routine(MAIL)]: failing }));
    expect(html).toContain('<span class="eos-status eos-status--err">Last run failed</span>');
    expect(html).toContain("The last run failed. A capability it reads with is missing or broken.");
  });

  it("says when the routine is gone or could not be read", async () => {
    setEosTransport(fixtureTransport({}));
    await loadRoutine("rt-gone");
    openLocation("eos:/routines/rt-gone");
    expect(draw()).toContain("This routine is no longer here.");

    setEosTransport({ get: async () => ({ ok: false, status: 500, body: {} }), send: vi.fn() });
    await loadRoutine("rt-broken");
    openLocation("eos:/routines/rt-broken");
    expect(draw()).toContain("Couldn&#x27;t load this routine.");
  });

  it("is what a project routine's run opens", async () => {
    const project = { ...runs[1], run: { ...runs[1].run, kind: "project" } };
    setEosTransport(fixtureTransport({ ...reads, [ROUTES.run(project.run.id)]: project, [ROUTES.routine(PR)]: routineDetail }));
    await loadRoutine(PR);
    await loadRun(project.run.id);
    openLocation(`eos:/runs/${project.run.id}`);
    expect(draw()).toContain('<h1 class="eos-title">PR Review</h1>');
  });
});

describe("the routine page's writes", () => {
  it("Pause shows at once and goes back when the core refuses it", async () => {
    let answer;
    const transport = recording(() => new Promise((resolve) => { answer = resolve; }));
    await page(`eos:/routines/${PR}`, transport);
    const pausing = setRoutineState(PR, "paused");
    expect(rowState(PR)).toBe("paused");
    expect(draw()).toContain("Paused by you.");
    expect(transport.send).toHaveBeenCalledWith("PUT", ROUTES.routineState(PR), { state: "paused" });
    answer({ ok: false, status: 500, body: { error: "no" } });
    expect(await pausing).toBe(false);
    expect(rowState(PR)).toBe("active");
  });

  it("Resume waits for the core and takes the row it answers", async () => {
    const resumed = { ...routinePaused.routine, state: "active", pausedReason: undefined };
    const transport = recording(async () => ({ ok: true, status: 200, body: resumed }));
    await page(`eos:/routines/${MAIL}`, transport);
    expect(await setRoutineState(MAIL, "active")).toBe(true);
    expect(rowState(MAIL)).toBe("active");
    expect(draw()).toContain(">Pause</button>");
  });

  it("says a dev run's refusal in words", async () => {
    await page(`eos:/routines/${PR}`, recording(async () => ({ ok: false, status: 403, body: { error: "refused in a dev run: PUT /api/routines/:id/state" } })));
    await setRoutineState(PR, "archived");
    expect(draw()).toContain(DEV_RUN_TEXT);
  });

  it("offers Start another like this, Save to a file, Archive and Delete to trash in the menu", async () => {
    expect(menuActions(routineDetail.routine).map((a) => a.label)).toEqual(["Start another like this", "Save to a file", "Archive", "Delete to trash"]);
    expect(menuActions({ ...routineDetail.routine, state: "archived" }).map((a) => a.label)).toEqual(["Start another like this", "Save to a file", "Delete to trash"]);

    const copy = { ...routineDetail.routine, id: "rt-copy", state: "draft" };
    const transport = recording(async () => ({ ok: true, status: 201, body: { row: copy, versionId: "rv-copy", warnings: [] } }));
    await page(`eos:/routines/${PR}`, transport);
    await menuActions(routineDetail.routine)[0].run();
    expect(transport.send).toHaveBeenCalledWith("POST", ROUTES.routineCopy(PR), undefined);
    expect(eosLocation()).toBe("eos:/routines/rt-copy?tab=blueprint");
  });

  it("saves the routine's file under its name", async () => {
    const file = { format: 1, routine: { id: PR, name: "PR Review" }, versions: [] };
    const saved = [];
    globalThis.document = { createElement: () => ({ click() { saved.push(this.download); } }) };
    const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    setEosTransport({ ...fixtureTransport({ [ROUTES.routineExport(PR)]: file }) });
    await menuActions(routineDetail.routine)[1].run();
    expect(saved).toEqual(["pr-review.eos-routine.json"]);
    expect(fileName("")).toBe("routine.eos-routine.json");
    created.mockRestore();
    delete globalThis.document;
  });

  it("archives through the state route and deletes to trash, leaving the page", async () => {
    const archived = { ...routineDetail.routine, state: "archived" };
    const transport = recording(async (method) => ({ ok: true, status: 200, body: method === "PUT" ? archived : { ...archived, state: "deleted" } }));
    await page(`eos:/routines/${PR}`, transport);
    const [, , archive, remove] = menuActions(routineDetail.routine);
    await archive.run();
    expect(transport.send).toHaveBeenCalledWith("PUT", ROUTES.routineState(PR), { state: "archived" });
    expect(rowState(PR)).toBe("archived");

    await remove.run();
    expect(transport.send).toHaveBeenLastCalledWith("DELETE", ROUTES.routine(PR), undefined);
    expect(eosLocation()).toBe("eos:/");
    expect(rowState(PR)).toBeUndefined();
  });
});
