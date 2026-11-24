import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetInbox, refreshInbox } from "../../../state/eos/inboxStore.js";
import { _resetRoutines, loadRoutine, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { _resetRunLive, applyRunActivity, retain } from "../../../state/eos/runLiveStore.js";
import { EosMain } from "../EosMain.jsx";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { doneCount, stepLabel } from "./ProjectSteps.jsx";
import routines from "../gallery/sample/routines.json";
import routineDetail from "../gallery/sample/routine-detail.json";
import inbox from "../gallery/sample/inbox.json";

vi.mock("../../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));
vi.mock("../../../api/client.js", () => ({ api: { setStreamFocus: async () => ({ ok: true, body: { live: [] } }) } }));
vi.mock("./ProjectPanel.jsx", () => ({ ProjectPanel: ({ routineId }) => <div data-panel={`eos:${routineId}`} /> }));

const ID = routineDetail.routine.id;
const milestones = [
  { key: "plan", title: "Plan and data model", doneWhen: "-" },
  { key: "grid", title: "Grid and camera", doneWhen: "-" },
  { key: "undo", title: "Undo stack", doneWhen: "-" },
  { key: "save", title: "Save and load", doneWhen: "-" },
];
const run = { ...routineDetail.routine.lastRun, id: "rn-project", kind: "project", state: "running", station: "work", milestonesDone: 2 };

function project(lastRun) {
  const blueprint = { ...routineDetail.head.blueprint, kind: "project", project: { repo: "/Users/me/game", baseBranch: "main", brief: "b", milestones } };
  return { ...routineDetail, routine: { ...routineDetail.routine, kind: "project", lastRun }, head: { ...routineDetail.head, blueprint } };
}

async function page(lastRun) {
  const detail = project(lastRun);
  setEosTransport(fixtureTransport({
    [ROUTES.routines]: routines.map((r) => (r.id === ID ? detail.routine : r)),
    [ROUTES.inbox]: inbox,
    [ROUTES.routine(ID)]: detail,
  }));
  await refreshRoutines();
  await refreshInbox();
  await loadRoutine(ID);
  openLocation(`eos:/routines/${ID}`);
  return renderToStaticMarkup(<EosMain />);
}

const steps = (html) => [...html.matchAll(/class="eos-step eos-step--(\w+)"[^>]*>.*?class="eos-step__title">([^<]*)</g)].map((m) => `${m[1]}:${m[2]}`);

beforeEach(() => {
  _resetRoutines();
  _resetInbox();
  _resetRunLive();
  _resetEosNav();
});
afterEach(() => setEosTransport(null));

describe("a project routine's page", () => {
  it("shows its steps, the one at work with its team's latest line, Tell the team and its side panel", async () => {
    let html = await page(run);
    expect(html).toContain('<span class="eos-chip">Step 3 of 4</span>');
    expect(steps(html)).toEqual(["done:Plan and data model", "done:Grid and camera", "now:Undo stack", "next:Save and load"]);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain(`data-panel="eos:${ID}"`);
    expect(html).toContain("Tell the team");

    // The page holds its run's lines once mounted (an effect a static render does not run).
    retain(run.id);
    applyRunActivity({ runId: run.id, workerId: "w-b2", line: "Edit src/undo.ts" });
    html = renderToStaticMarkup(<EosMain />);
    expect(html).toContain('<span class="eos-step__line">Edit src/undo.ts</span>');
  });

  it("ends with every step done and nothing to tell", async () => {
    const html = await page({ ...run, state: "done", milestonesDone: 3 });
    expect(steps(html).every((step) => step.startsWith("done:"))).toBe(true);
    expect(html).not.toContain("Tell the team");
    expect(html).toContain("Step 4 of 4");
  });

  it("counts its steps from the run", () => {
    expect([doneCount(null, 4), doneCount({ state: "running", milestonesDone: 9 }, 4), doneCount({ state: "done" }, 4)]).toEqual([0, 4, 4]);
    expect([stepLabel(0, 4), stepLabel(4, 4)]).toEqual(["Step 1 of 4", "Step 4 of 4"]);
  });
});
