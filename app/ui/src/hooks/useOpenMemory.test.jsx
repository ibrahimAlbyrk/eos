import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const ui = { closeAllPops: vi.fn(), setActiveView: vi.fn() };
const settings = { closeSettings: vi.fn() };
vi.mock("../state/ui.jsx", () => ({ useUi: () => ui }));
vi.mock("../state/settings.jsx", () => ({ useSettings: () => settings }));

const { useOpenMemory } = await import("./useOpenMemory.js");
const { probeEosStatus } = await import("../state/eos/eosStatusStore.js");
const { fixtureTransport, setEosTransport } = await import("../state/eos/transport.js");
const { ROUTES } = await import("../api/routes.js");
const { _resetEosNav, eosLocation } = await import("../views/eos/nav/eosNav.js");
const { useMemoryViewing, _resetMemoryView } = await import("../state/memoryViewStore.js");

function open() {
  let openMemory;
  function Probe() {
    openMemory = useOpenMemory();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  openMemory();
}

function viewing() {
  let on;
  function Probe() {
    on = useMemoryViewing();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return on;
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetEosNav();
  _resetMemoryView();
});
afterEach(() => setEosTransport(null));

describe("opening Memory", () => {
  it("opens Eos › Memory › About you while Eos is shown", async () => {
    setEosTransport(fixtureTransport({ [ROUTES.routines]: [] }));
    await probeEosStatus();
    open();
    expect(settings.closeSettings).toHaveBeenCalledOnce();
    expect(ui.closeAllPops).toHaveBeenCalledOnce();
    expect(ui.setActiveView).toHaveBeenCalledWith("eos");
    expect(eosLocation()).toBe("eos:/memory?tab=about");
    expect(viewing()).toBe(false);
  });

  it("takes over the Agents main area while Eos is hidden", async () => {
    setEosTransport(fixtureTransport({}));
    await probeEosStatus();
    open();
    expect(ui.setActiveView).toHaveBeenCalledWith("agents");
    expect(viewing()).toBe(true);
  });
});
