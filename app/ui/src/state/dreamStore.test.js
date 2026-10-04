import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    getDreamStatus: vi.fn(),
    listDreams: vi.fn(),
    dreamNow: vi.fn(),
    stopDream: vi.fn(),
    setDreamExclusion: vi.fn(),
  },
}));

import { api } from "../api/client.js";
import {
  _resetDreams, applyDreamChange, dreamNow, ensureDreamStatusLoaded, getDreamState, refreshDreamLog, setDreamExclusion,
} from "./dreamStore.js";

beforeEach(() => {
  _resetDreams();
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("dreamStore", () => {
  it("loads status once", async () => {
    api.getDreamStatus.mockResolvedValue({ running: false, lastRun: null, nextAt: null, blocked: "disabled", progress: null, runId: null });
    await Promise.all([ensureDreamStatusLoaded(), ensureDreamStatusLoaded()]);
    expect(api.getDreamStatus).toHaveBeenCalledTimes(1);
    expect(getDreamState().status.blocked).toBe("disabled");
  });

  it("dream now surfaces a refusal", async () => {
    api.getDreamStatus.mockResolvedValue({ running: true });
    api.dreamNow.mockResolvedValue({ ok: false, status: 409, body: { error: "A dream is already running" } });
    await dreamNow();
    expect(getDreamState().error).toBe("A dream is already running");
  });

  it("exclusions apply at once and take the daemon's answer", async () => {
    api.setDreamExclusion.mockResolvedValue({ ok: true, body: { excluded: ["w-1"] } });
    const p = setDreamExclusion("w-1", true);
    expect(getDreamState().excluded).toEqual(["w-1"]);
    await p;
    expect(api.setDreamExclusion).toHaveBeenCalledWith("w-1", true);
  });

  it("a burst of dream:change re-reads status once; the open log only when a run ends", async () => {
    vi.useFakeTimers();
    api.getDreamStatus.mockResolvedValue({ running: true });
    api.listDreams.mockResolvedValue({ runs: [], excluded: [] });
    await refreshDreamLog();
    applyDreamChange({ status: "running" });
    applyDreamChange({ status: "running" });
    await vi.advanceTimersByTimeAsync(200);
    expect(api.getDreamStatus).toHaveBeenCalledTimes(1);
    expect(api.listDreams).toHaveBeenCalledTimes(1);
    applyDreamChange({ status: "done" });
    await vi.advanceTimersByTimeAsync(200);
    expect(api.listDreams).toHaveBeenCalledTimes(2);
  });
});
