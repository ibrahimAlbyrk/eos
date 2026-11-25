import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client.js", () => ({ api: { findRunAgent: vi.fn() } }));
vi.mock("../views/eos/nav/eosNav.js", () => ({ openEosRoute: vi.fn() }));

import { api } from "../api/client.js";
import { openEosRoute } from "../views/eos/nav/eosNav.js";
import { _resetAgentIndex, updateAgentIndex } from "./agentIndex.js";
import { openAgent } from "./openAgent.js";

const ui = () => ({ setActiveView: vi.fn(), selectAgent: vi.fn() });

beforeEach(() => {
  _resetAgentIndex();
  vi.clearAllMocks();
});

describe("openAgent", () => {
  it("a chat in the Agents list opens in Agents without asking the core", async () => {
    updateAgentIndex([{ id: "w-chat", parent_id: null }]);
    const at = ui();
    await openAgent("w-chat", at);
    expect(api.findRunAgent).not.toHaveBeenCalled();
    expect(at.setActiveView).toHaveBeenCalledWith("agents");
    expect(at.selectAgent).toHaveBeenCalledWith("w-chat");
  });

  it("an agent working for a run opens that run in Eos", async () => {
    api.findRunAgent.mockResolvedValue({ runId: "run 7", routineId: "rt-1", role: "lead" });
    const at = ui();
    await openAgent("w-lead", at);
    expect(api.findRunAgent).toHaveBeenCalledWith("w-lead");
    expect(openEosRoute).toHaveBeenCalledWith("eos:/runs/run%207", at.setActiveView);
    expect(at.selectAgent).not.toHaveBeenCalled();
  });

  it("an id the core knows no run for opens Agents on it, as before", async () => {
    api.findRunAgent.mockResolvedValue(null);
    const at = ui();
    await openAgent("w-archived", at);
    expect(openEosRoute).not.toHaveBeenCalled();
    expect(at.selectAgent).toHaveBeenCalledWith("w-archived");
  });
});
