import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetSurfaces, refreshSurfaces, runSurfaceAction, useSurfaces } from "../../../state/eos/surfacesStore.js";
import { UiProvider } from "../../../state/ui.jsx";
import { SurfaceCard } from "./SurfaceCard.jsx";

vi.mock("../../../lib/markdown.js", () => ({ renderMarkdown: (text) => `<md>${text}</md>` }));

const surface = { id: "sf-5a3b1e000001", routineId: "rt-sample000004", level: "view", place: "needs_you", role: "result", title: "Morning Mail" };
const issue = { id: "si-5a3b1e000003", surfaceId: surface.id, seq: 3, kind: "view", status: "ready", rev: 1, trial: false, createdAt: 1795000000000 };
const view = {
  title: "Overnight mail", summary: "12 mails came in.",
  ui: '<Callout action="again">12 mails came in overnight.</Callout>',
  actions: { again: { label: "Run again", kind: "send", text: "again" } },
};
const reads = {
  [`${ROUTES.surfaces}?place=needs_you`]: { surfaces: [surface, { ...surface, id: "sf-page", level: "page" }] },
  [`${ROUTES.surfaceIssues(surface.id)}?limit=1`]: { issues: [issue], more: true },
  [ROUTES.surfaceIssue(surface.id, issue.id)]: { issue, body: { view, actions: ["again"] } },
};

function cards() {
  let read;
  function Probe() {
    read = useSurfaces();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read.cards;
}

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k) };
}

beforeEach(() => {
  _resetSurfaces();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  setEosTransport(null);
  delete globalThis.localStorage;
});

describe("a routine's View in Needs you", () => {
  it("is read as the newest ready issue of each View surface placed there", async () => {
    setEosTransport(fixtureTransport(reads));
    await refreshSurfaces();
    expect(cards()).toEqual([{ surface, issue, body: { view, actions: ["again"] } }]);
  });

  it("draws the View in Eos's frame, which says who made it and that it is a View", () => {
    const html = renderToStaticMarkup(
      <UiProvider><SurfaceCard card={{ surface, issue, body: { view } }} routineName="Morning Mail" /></UiProvider>,
    );
    expect(html).toContain('<section class="eos-frame" aria-label="Made by Morning Mail">');
    expect(html).toContain('<span class="eos-frame__level">View</span>');
    expect(html).toContain("Overnight mail");
    expect(html).toContain("12 mails came in overnight.");
  });

  it("presses a button with the issue, the action's name and what the user typed, never arguments", async () => {
    const send = vi.fn(async () => ({ ok: true, status: 202, body: { status: "confirm", recordId: "da-1", token: "t-1", prompt: "Run Morning Mail again?" } }));
    setEosTransport({ ...fixtureTransport(reads), send });
    const answer = await runSurfaceAction({ issueId: issue.id, actionId: "again", state: { note: "short" }, clientId: "c-1" });
    expect(answer).toEqual({ status: "confirm", recordId: "da-1", token: "t-1", prompt: "Run Morning Mail again?" });
    await runSurfaceAction({ issueId: issue.id, actionId: "again", clientId: "c-1", confirm: "t-1" });
    expect(send.mock.calls).toEqual([
      ["POST", ROUTES.actionsRun, { issueId: issue.id, actionId: "again", clientId: "c-1", state: { note: "short" } }],
      ["POST", ROUTES.actionsRun, { issueId: issue.id, actionId: "again", clientId: "c-1", confirm: "t-1" }],
    ]);
  });

  it("says so when a dev run refuses the press", async () => {
    const send = async () => ({ ok: false, status: 403, body: { error: "refused in a dev run: POST /api/actions/run" } });
    setEosTransport({ ...fixtureTransport(reads), send });
    const answer = await runSurfaceAction({ issueId: issue.id, actionId: "again", clientId: "c-2" });
    expect(answer).toEqual({ status: "refused", reason: "This is a dev run: nothing runs from here." });
  });
});
