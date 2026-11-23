import { describe, it, expect, vi, afterEach } from "vitest";
import { ROUTES } from "../api/routes.js";
import { fixtureTransport, setEosTransport } from "../state/eos/transport.js";
import { probeEosStatus } from "../state/eos/eosStatusStore.js";
import { visibleTabs } from "./tabs.js";
import { getViewComponent, getViewSidebar, keepsMounted } from "./registry.js";
import { EosView } from "./eos/EosView.jsx";
import { EosSidebar } from "./eos/sidebar/EosSidebar.jsx";

// The other modes' views need a browser to load; only their places in the registry matter here.
vi.mock("./agents/AgentsView.jsx", () => ({ AgentsView: () => null }));
vi.mock("./agents/sidebar/AgentsSidebar.jsx", () => ({ AgentsSidebar: () => null }));
vi.mock("./code/CodeView.jsx", () => ({ CodeView: () => null }));
vi.mock("./code/sidebar/CodeSidebar.jsx", () => ({ CodeSidebar: () => null }));
vi.mock("./machines/MachinesView.jsx", () => ({ MachinesView: () => null }));
vi.mock("./machines/MachinesSidebar.jsx", () => ({ MachinesSidebar: () => null }));

async function eosServed(served) {
  setEosTransport(fixtureTransport(served ? { [ROUTES.routines]: [] } : {}));
  await probeEosStatus();
}

const ids = () => visibleTabs().map((t) => t.id);

afterEach(() => setEosTransport(null));

describe("modes", () => {
  it("are today's list while Eos is hidden", async () => {
    await eosServed(false);
    expect(ids()).toEqual(["agents", "code", "machines"]);
  });

  it("put Eos first once the core serves routines", async () => {
    await eosServed(true);
    expect(ids()).toEqual(["eos", "agents", "code", "machines"]);
    expect(visibleTabs()[0].label).toBe("Eos");
  });

  it("draw Eos with its own view and sidebar, not kept mounted", () => {
    expect(getViewComponent("eos")).toBe(EosView);
    expect(getViewSidebar("eos")).toBe(EosSidebar);
    expect(keepsMounted("eos")).toBe(false);
  });
});
