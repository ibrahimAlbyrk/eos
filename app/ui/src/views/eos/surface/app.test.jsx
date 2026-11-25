import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetPages, loadPage, loadRoutineApp, loadVersion, usePages } from "../../../state/eos/pageStore.js";
import { _resetPins, refreshPins } from "../../../state/eos/pinsStore.js";
import { _resetRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { callSurfaceApp, promoteApp } from "../../../state/eos/surfacesStore.js";
import { getPanel } from "../../../lib/panelRegistry.js";
import { surfaceAppIdOf, surfaceAppTabId } from "../../../lib/panelTabs.js";
import { EosMain } from "../EosMain.jsx";
import { _resetEosNav, openLocation } from "../nav/eosNav.js";
import { tileAction, tileLocation } from "../home/PinnedTiles.jsx";
import { setAlwaysSend } from "../../../genui/apps/trust.js";
import { AppSurface } from "./AppSurface.jsx";
import { UiProvider } from "../../../state/ui.jsx";
import "./registerSurfacePanel.js";
import routines from "../gallery/sample/routines.json";

vi.mock("../../../api/client.js", () => ({ api: { setStreamFocus: async () => ({ ok: true, body: { live: [] } }) } }));

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const SF = "sf-levels";
const surface = {
  id: SF, routineId: routines[0].id, level: "app", place: "routine_page", role: "app", title: "Level preview",
  currentVersion: 2, createdAt: 1, updatedAt: 2,
};
const version = {
  meta: { version: 2, status: "kept", madeBy: "builder", note: "", bodyBytes: 10, createdAt: 1 },
  body: { html: "<p id=\"lv\">levels</p>", manifest: { title: "Level preview", summary: "Shows a level.", height: 420, uses: [], queries: [] } },
  checks: {},
  accessLine: "This App can read levels/*.json in this project.",
};
const reads = {
  [ROUTES.routines]: routines,
  [ROUTES.surface(SF)]: surface,
  [`${ROUTES.surfaceIssues(SF)}?limit=20`]: { issues: [], more: false },
  [ROUTES.surfaceVersion(SF, 2)]: version,
  [ROUTES.surfacePins]: { surfaces: [] },
  [ROUTES.surfaceTiles]: { tiles: [] },
  [`${ROUTES.surfaces}?routine=${encodeURIComponent(routines[0].id)}`]: { surfaces: [surface, { ...surface, id: "sf-page", level: "page" }] },
};

async function loaded() {
  setEosTransport(fixtureTransport(reads));
  await refreshRoutines();
  await refreshPins();
  await loadPage(SF);
  await loadVersion(SF, 2);
}

beforeEach(() => {
  _resetPages();
  _resetPins();
  _resetRoutines();
  _resetEosNav();
});
afterEach(() => setEosTransport(null));

describe("a routine's App", () => {
  it("runs in its sandboxed frame with the line of access Eos wrote, Pin to Home and Open as a tool", async () => {
    await loaded();
    const html = renderToStaticMarkup(<UiProvider><AppSurface surfaceId={SF} inPanel /></UiProvider>);
    expect(html).toContain("Level preview");
    expect(html).toContain(`An app made by ${routines[0].name}`);
    expect(html).toContain('sandbox="allow-scripts allow-forms"');
    expect(html).toContain("<strong>Runs in a sandbox.</strong> This App can read levels/*.json in this project.");
    expect(html).toContain("Pin to Home");
    expect(html).toContain("Open as a tool");
  });

  it("asks before every link even when Always was chosen for it once", async () => {
    await loaded();
    setAlwaysSend(`surface-${SF}`, true);
    const html = renderToStaticMarkup(<UiProvider><AppSurface surfaceId={SF} inPanel /></UiProvider>);
    setAlwaysSend(`surface-${SF}`, false);
    expect(html).toContain("sends nothing without your OK");
    expect(html).not.toContain("Ask again");
  });

  it("opens as a tool on its own screen, without the panel's Open as a tool", async () => {
    await loaded();
    openLocation(`eos:/surfaces/${SF}`);
    const html = renderToStaticMarkup(<UiProvider><EosMain /></UiProvider>);
    expect(html).toContain('sandbox="allow-scripts allow-forms"');
    expect(html).not.toContain("Open as a tool");
    expect(html).toContain("Make it an Extension");
    expect(html.indexOf("Make it an Extension")).toBeLessThan(html.indexOf("eos-body"));
    expect(html).toContain(`App · made by ${routines[0].name}`);
    expect(html).toContain('<p class="eos-lead">Shows a level.</p>');
  });

  it("hands the App to the Forge to become an Extension", async () => {
    const sent = [];
    setEosTransport({ get: async () => ({ ok: false, status: 404 }), send: async (m, p, b) => { sent.push([m, p, b]); return { ok: true, status: 200, body: { runId: "rn-9" } }; } });
    expect(await promoteApp(SF, "Level preview")).toEqual({ runId: "rn-9" });
    expect(sent[0]).toEqual(["POST", ROUTES.forge, { need: "Make the App Level preview an Extension", fromSurface: SF }]);
  });

  it("with no version in use yet shows no frame", async () => {
    setEosTransport(fixtureTransport({ ...reads, [ROUTES.surface(SF)]: { ...surface, currentVersion: null } }));
    await loadPage(SF);
    const html = renderToStaticMarkup(<AppSurface surfaceId={SF} />);
    expect(html).not.toContain("<iframe");
    expect(html).toContain("once its review and its tests pass");
  });

  it("is a tab of Eos's side panel, named by its title", async () => {
    await loaded();
    expect(surfaceAppIdOf(surfaceAppTabId(SF))).toBe(SF);
    const panel = getPanel("surface-app");
    expect(panel.surface).toEqual(["eos"]);
  });

  it("is found for its routine's side panel only with a version in use", async () => {
    await loaded();
    await loadRoutineApp(routines[0].id);
    expect(usePagesState().appByRoutine[routines[0].id]).toBe(SF);
  });

  it("pins as a tile that opens the App", () => {
    const tile = { surfaceId: SF, routineId: "rt", level: "app", title: "Level preview" };
    expect(tileAction(tile)).toBe("Open the App");
    expect(tileLocation(tile)).toBe(`eos:/surfaces/${SF}`);
  });

  it("relays a call to the core and reads its refusal as the App's error", async () => {
    const sent = [];
    setEosTransport({
      get: async () => ({ ok: false, status: 404, body: {} }),
      send: async (method, path, body) => {
        sent.push({ method, path, body });
        return body.name === "state.get"
          ? { ok: true, status: 200, body: { result: { data: { n: 1 } } } }
          : { ok: false, status: 403, body: { error: "this App's manifest does not use `x.y`" } };
      },
    });
    expect(await callSurfaceApp({ surfaceId: SF, version: 2, name: "state.get" })).toEqual({ data: { n: 1 } });
    expect(sent[0]).toEqual({ method: "POST", path: ROUTES.surfaceAppCall(SF), body: { version: 2, name: "state.get", arguments: {} } });
    await expect(callSurfaceApp({ surfaceId: SF, version: 2, name: "x.y", clientId: "c" })).rejects.toThrow("does not use");
  });
});

// The store's state outside a component.
function usePagesState() {
  let seen;
  function Probe() { seen = usePages(); return null; }
  renderToStaticMarkup(<Probe />);
  return seen;
}
