import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ROUTES } from "../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../state/eos/transport.js";
import { _resetRoutines, refreshRoutines } from "../../state/eos/routinesStore.js";
import { _resetRunSheet, registerHost, useRunSheet } from "../../state/eos/runSheetStore.js";
import { createSearchRegistry } from "../registry.js";
import { routinesProvider } from "./routines.js";
import { needsProvider } from "./needs.js";
import routines from "../../views/eos/gallery/sample/routines.json";

beforeEach(() => { _resetRoutines(); _resetRunSheet(); });
afterEach(() => setEosTransport(null));

describe("⌘K and routines", () => {
  it("offers Run … for each routine and Stop everything, and a choice opens the sheet centred", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.routines]: routines }));
    await refreshRoutines();
    const live = routines.filter((r) => !["transient", "archived", "deleted"].includes(r.state));
    const results = routinesProvider.getResults();
    expect(results.map((r) => r.title)).toEqual([...live.map((r) => `Run ${r.name}…`), "Stop everything"]);

    const unhost = registerHost();
    const setActiveView = vi.fn();
    results[0].onSelect({ setActiveView });
    expect(setActiveView).toHaveBeenCalledWith("eos");
    let sheet;
    const { renderToStaticMarkup } = await import("react-dom/server");
    function Probe() { sheet = useRunSheet(); return null; }
    renderToStaticMarkup(<Probe />);
    expect(sheet.request).toEqual({ routineId: live[0].id, anchor: undefined, door: "palette" });
    unhost();
  });

  it("finds a routine by its slug through the palette's ranking", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.routines]: routines }));
    await refreshRoutines();
    const registry = createSearchRegistry([routinesProvider]);
    const [group] = registry.search(routines[0].slug, {});
    expect(group.items[0].title).toBe(`Run ${routines[0].name}…`);
  });

  it("lists nothing from Needs you before it loads", () => {
    expect(needsProvider.getResults()).toEqual([]);
  });
});
