import { describe, it, expect, vi } from "vitest";

vi.mock("../api/client.js", () => ({ api: { getUsage: vi.fn() } }));

import { api } from "../api/client.js";
import { applyUsageChange, getUsageState, loadUsage } from "./usageStore.js";

const usage = (used) => ({ providers: [{ provider: "claude", windows: { fiveHour: { utilization: used, resetsAt: null } }, fetchedAt: "t" }] });

describe("usageStore", () => {
  it("keeps a pushed refresh over a load that was answered before it", async () => {
    let answer;
    api.getUsage.mockReturnValueOnce(new Promise((r) => { answer = r; }));
    const load = loadUsage();
    applyUsageChange(usage(70));
    answer(usage(41));
    await load;
    expect(getUsageState().usage).toEqual(usage(70));

    api.getUsage.mockResolvedValueOnce(usage(80));
    await loadUsage();
    expect(getUsageState().usage).toEqual(usage(80));
  });
});
