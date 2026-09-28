import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/client.js", () => ({
  api: {
    listAccounts: vi.fn(),
    uiConfig: vi.fn(async () => null),
    startSignIn: vi.fn(),
    getSignIn: vi.fn(),
    cancelSignIn: vi.fn(async () => ({ ok: true })),
    submitSignInCode: vi.fn(),
    signOut: vi.fn(),
    setAnthropicConfig: vi.fn(),
    testBackend: vi.fn(),
    addBackend: vi.fn(),
    deleteBackend: vi.fn(),
  },
}));

import { api } from "../api/client.js";
import {
  _resetAccounts, getAccountsState, refreshAccounts, startSignIn, cancelSignIn, submitSignInCode,
  saveApiKey, removeApiKey, accountTone, noAccountConnected, isUsable,
} from "./accountsStore.js";

const claude = { id: "anthropic", route: "none", subscription: { supported: true, state: "signed_out" }, apiKey: { set: false } };
const openai = { id: "openai", route: "none", subscription: { supported: false, state: "signed_out" }, apiKey: { set: false } };

beforeEach(() => {
  _resetAccounts();
  vi.clearAllMocks();
  api.listAccounts.mockResolvedValue([claude, openai]);
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("selectors", () => {
  it("tone follows the billing route", () => {
    expect(accountTone({ route: "subscription" })).toBe("ok");
    expect(accountTone({ route: "api_key" })).toBe("key");
    expect(accountTone({ route: "blocked" })).toBe("expired");
    expect(accountTone({ route: "none" })).toBe(null);
  });

  it("only subscription and api_key are usable; an expired sign-in still counts as connected", () => {
    expect(isUsable({ route: "blocked" })).toBe(false);
    expect(noAccountConnected([{ route: "none" }, { route: "blocked" }])).toBe(false);
    expect(noAccountConnected([{ route: "none" }])).toBe(true);
    expect(noAccountConnected(null)).toBe(false);
  });
});

describe("sign-in", () => {
  it("polls a waiting sign-in until it succeeds, then reloads accounts", async () => {
    await refreshAccounts();
    api.startSignIn.mockResolvedValue({ ok: true, body: { id: "s1", provider: "anthropic", state: "waiting", url: "https://x" } });
    await startSignIn("anthropic");
    expect(getAccountsState().signIns.anthropic.state).toBe("waiting");

    api.getSignIn.mockResolvedValue({ ok: true, status: 200, body: { id: "s1", provider: "anthropic", state: "succeeded" } });
    api.listAccounts.mockResolvedValue([{ ...claude, route: "subscription" }, openai]);
    await vi.advanceTimersByTimeAsync(1000);

    expect(getAccountsState().signIns.anthropic).toBeUndefined();
    expect(api.uiConfig).toHaveBeenCalled();
    expect(getAccountsState().accounts[0].route).toBe("subscription");
  });

  it("a sign-in the daemon forgot (404) fails instead of spinning forever", async () => {
    api.startSignIn.mockResolvedValue({ ok: true, body: { id: "s1", provider: "anthropic", state: "waiting" } });
    await startSignIn("anthropic");
    api.getSignIn.mockResolvedValue({ ok: false, status: 404, body: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(getAccountsState().signIns.anthropic).toMatchObject({ state: "failed", error: expect.stringMatching(/interrupted/) });
  });

  it("a transient poll error keeps waiting", async () => {
    api.startSignIn.mockResolvedValue({ ok: true, body: { id: "s1", provider: "anthropic", state: "waiting" } });
    await startSignIn("anthropic");
    api.getSignIn.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(getAccountsState().signIns.anthropic.state).toBe("waiting");
  });

  it("a refused start surfaces the daemon's reason", async () => {
    api.startSignIn.mockResolvedValue({ ok: false, status: 404, body: { error: 'sign-in is not supported for "openai"' } });
    await startSignIn("openai");
    expect(getAccountsState().signIns.openai).toMatchObject({ state: "failed", error: 'sign-in is not supported for "openai"' });
  });

  it("cancel clears locally and tells the daemon", async () => {
    api.startSignIn.mockResolvedValue({ ok: true, body: { id: "s1", provider: "anthropic", state: "waiting" } });
    await startSignIn("anthropic");
    await cancelSignIn("anthropic");
    expect(getAccountsState().signIns.anthropic).toBeUndefined();
    expect(api.cancelSignIn).toHaveBeenCalledWith("s1");
  });

  it("forwards a pasted code to the active sign-in", async () => {
    api.startSignIn.mockResolvedValue({ ok: true, body: { id: "s1", provider: "anthropic", state: "waiting" } });
    await startSignIn("anthropic");
    api.submitSignInCode.mockResolvedValue({ ok: true, body: {} });
    expect(await submitSignInCode("anthropic", "abc")).toEqual({ ok: true });
    expect(api.submitSignInCode).toHaveBeenCalledWith("s1", "abc");
    expect((await submitSignInCode("openai", "x")).ok).toBe(false);
  });
});

describe("API keys", () => {
  it("Claude's key goes to the anthropic config", async () => {
    api.setAnthropicConfig.mockResolvedValue({ ok: true, body: {} });
    expect(await saveApiKey(claude, "  sk-ant  ")).toEqual({ ok: true });
    expect(api.setAnthropicConfig).toHaveBeenCalledWith({ apiKey: "sk-ant" });
    expect(api.testBackend).not.toHaveBeenCalled();
  });

  it("a preset's key is tested before it is stored, and a failing key never lands", async () => {
    api.testBackend.mockResolvedValue({ ok: false, status: 400, body: { ok: false, error: "401 Unauthorized" } });
    expect(await saveApiKey(openai, "sk-bad")).toEqual({ ok: false, error: "401 Unauthorized" });
    expect(api.addBackend).not.toHaveBeenCalled();

    api.testBackend.mockResolvedValue({ ok: true, status: 200, body: { ok: true } });
    api.addBackend.mockResolvedValue({ ok: true, status: 201, body: {} });
    expect(await saveApiKey(openai, "sk-good")).toEqual({ ok: true });
    expect(api.addBackend).toHaveBeenCalledWith({ name: "openai", preset: "openai", apiKey: "sk-good" });
  });

  it("removes a preset key by deleting its profile", async () => {
    api.deleteBackend.mockResolvedValue({ ok: true, body: {} });
    await removeApiKey({ ...openai, profile: "my-openai" });
    expect(api.deleteBackend).toHaveBeenCalledWith("my-openai");
  });

  it("refuses an empty key without a request", async () => {
    expect((await saveApiKey(claude, "   ")).ok).toBe(false);
    expect(api.setAnthropicConfig).not.toHaveBeenCalled();
  });
});
