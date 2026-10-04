import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    listUserMemories: vi.fn(),
    approveUserMemory: vi.fn(),
    dismissUserMemory: vi.fn(),
    approveAllUserMemories: vi.fn(),
    deleteUserMemory: vi.fn(),
    updateUserMemory: vi.fn(),
    createUserMemory: vi.fn(),
  },
}));

import { api } from "../api/client.js";
import {
  _resetUserMemories, approveMemory, dismissMemory, ensureUserMemoriesLoaded, getUserMemoriesState, pendingMemories,
} from "./userMemoryStore.js";

const m = (id, status = "active") => ({ id, text: id, status });

beforeEach(() => {
  _resetUserMemories();
  vi.clearAllMocks();
});

describe("userMemoryStore", () => {
  it("loads once and counts pending suggestions", async () => {
    api.listUserMemories.mockResolvedValue([m("um-1"), m("um-2", "suggested")]);
    await Promise.all([ensureUserMemoriesLoaded(), ensureUserMemoriesLoaded()]);
    expect(api.listUserMemories).toHaveBeenCalledTimes(1);
    expect(pendingMemories(getUserMemoriesState()).map((x) => x.id)).toEqual(["um-2"]);
  });

  it("keep and dismiss apply at once, then re-read", async () => {
    api.listUserMemories.mockResolvedValueOnce([m("um-1", "suggested"), m("um-2", "suggested")]);
    await ensureUserMemoriesLoaded();
    api.approveUserMemory.mockResolvedValue({ ok: true });
    api.listUserMemories.mockResolvedValue([m("um-1"), m("um-2", "suggested")]);
    const keep = approveMemory("um-1");
    expect(getUserMemoriesState().memories[0].status).toBe("active"); // optimistic
    await keep;
    api.dismissUserMemory.mockResolvedValue({ ok: true });
    api.listUserMemories.mockResolvedValue([m("um-1")]);
    const dismiss = dismissMemory("um-2");
    expect(getUserMemoriesState().memories.map((x) => x.id)).toEqual(["um-1"]); // optimistic
    await dismiss;
    expect(getUserMemoriesState().error).toBe(null);
  });

  it("a refused mutation surfaces the error and restores the truth", async () => {
    api.listUserMemories.mockResolvedValue([m("um-1", "suggested")]);
    await ensureUserMemoriesLoaded();
    api.approveUserMemory.mockResolvedValue({ ok: false, status: 403, body: { error: "ui token required" } });
    await approveMemory("um-1");
    expect(getUserMemoriesState().error).toBe("ui token required");
    expect(getUserMemoriesState().memories[0].status).toBe("suggested");
  });
});
