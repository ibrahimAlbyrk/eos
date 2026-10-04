import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    getProfile: vi.fn(),
    updateProfile: vi.fn(),
    uploadProfileAvatar: vi.fn(),
    deleteProfileAvatar: vi.fn(),
  },
}));

import { api } from "../api/client.js";
import {
  _resetProfile, applyProfileChange, ensureProfileLoaded, getProfileState, saveProfile,
} from "./profileStore.js";

const base = (rev, over = {}) => ({
  rev, updatedAt: 0,
  identity: { fullName: "", callName: "", handle: "", avatar: null },
  language: { chat: null, code: null },
  work: { roles: [], stack: [], level: null },
  style: { replies: null, autonomy: null, whenUnclear: null, commits: null },
  instructions: "", sharing: { withholdFrom: [] }, budgetTokens: 800, onboardedAt: null,
  ...over,
});

beforeEach(() => {
  _resetProfile();
  vi.clearAllMocks();
});

describe("profileStore", () => {
  it("loads once", async () => {
    api.getProfile.mockResolvedValue(base(0));
    await Promise.all([ensureProfileLoaded(), ensureProfileLoaded()]);
    expect(api.getProfile).toHaveBeenCalledTimes(1);
    expect(getProfileState().profile.rev).toBe(0);
  });

  it("saves optimistically and chains baseRev across saves", async () => {
    api.getProfile.mockResolvedValue(base(0));
    await ensureProfileLoaded();
    api.updateProfile
      .mockResolvedValueOnce({ ok: true, status: 200, body: { profile: base(1, { instructions: "a" }) } })
      .mockResolvedValueOnce({ ok: true, status: 200, body: { profile: base(2, { instructions: "b" }) } });
    const first = saveProfile({ instructions: "a" });
    expect(getProfileState().profile.instructions).toBe("a"); // optimistic
    const second = saveProfile({ instructions: "b" });
    await Promise.all([first, second]);
    expect(api.updateProfile.mock.calls.map((c) => c[1])).toEqual([0, 1]);
    expect(getProfileState()).toMatchObject({ status: "saved", profile: { rev: 2, instructions: "b" } });
  });

  it("a 409 adopts the daemon's copy and re-applies the patch once", async () => {
    api.getProfile.mockResolvedValue(base(0));
    await ensureProfileLoaded();
    api.updateProfile
      .mockResolvedValueOnce({ ok: false, status: 409, body: { profile: base(5, { identity: { fullName: "Other", callName: "", handle: "", avatar: null } }) } })
      .mockResolvedValueOnce({ ok: true, status: 200, body: { profile: base(6) } });
    await saveProfile({ instructions: "mine" });
    expect(api.updateProfile.mock.calls[1]).toEqual([{ instructions: "mine" }, 5]);
    expect(getProfileState().profile.rev).toBe(6);
  });

  it("a failed save surfaces the error and reloads the truth", async () => {
    api.getProfile.mockResolvedValue(base(0));
    await ensureProfileLoaded();
    api.updateProfile.mockResolvedValueOnce({ ok: false, status: 403, body: { error: "ui token required" } });
    const r = await saveProfile({ instructions: "x" });
    expect(r).toEqual({ ok: false, error: "ui token required" });
    expect(getProfileState().status).toBe("error");
    expect(api.getProfile).toHaveBeenCalledTimes(2);
  });

  it("SSE change refetches only when newer", async () => {
    api.getProfile.mockResolvedValue(base(3));
    await ensureProfileLoaded();
    applyProfileChange({ rev: 3 });
    expect(api.getProfile).toHaveBeenCalledTimes(1);
    applyProfileChange({ rev: 4 });
    expect(api.getProfile).toHaveBeenCalledTimes(2);
  });
});
