import { describe, it, expect, beforeEach, vi } from "vitest";

// homeStore seeds its selection + pre-spawn config from localStorage at import
// time; hoisted so the stub exists before the module under test loads.
const stored = vi.hoisted(() => {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
  return m;
});

vi.mock("../api/client.js", () => ({
  api: {
    spawnHome: vi.fn(),
    listHomeSessions: vi.fn(async () => []),
    deleteHome: vi.fn(),
  },
}));

import { api } from "../api/client.js";
import { createHome, setHomeConfig, getSnapshot } from "./homeStore.js";

describe("homeStore pre-spawn config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.spawnHome.mockResolvedValue({ body: { id: "w-1" } });
  });

  it("defaults to opus/high and sends them to spawnHome", async () => {
    expect(getSnapshot().model).toBe("opus");
    expect(getSnapshot().effort).toBe("high");
    await createHome("hello");
    expect(api.spawnHome).toHaveBeenCalledWith({ model: "opus", effort: "high", prompt: "hello" });
  });

  it("a picked model/effort persists and rides the next spawn", async () => {
    setHomeConfig({ model: "sonnet" });
    setHomeConfig({ effort: "max" });
    expect(stored.get("cm:homeModel")).toBe("sonnet");
    expect(stored.get("cm:homeEffort")).toBe("max");
    await createHome();
    expect(api.spawnHome).toHaveBeenCalledWith({ model: "sonnet", effort: "max" });
  });

  it("selects the created conversation", async () => {
    await createHome("hi");
    expect(getSnapshot().selectedId).toBe("w-1");
  });
});
