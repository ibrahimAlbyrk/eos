import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eosLocation, _resetEosNav } from "../views/eos/nav/eosNav.js";
import { openNativeRoute } from "./nativeRoute.js";

function handlers() {
  return { openMemory: vi.fn(), setActiveView: vi.fn(), openPanel: vi.fn() };
}

beforeEach(() => {
  _resetEosNav();
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
});
afterEach(() => {
  delete globalThis.localStorage;
});

describe("a route from the native app", () => {
  it("memory opens Memory and nothing else", () => {
    const h = handlers();
    openNativeRoute("memory", h);
    expect(h.openMemory).toHaveBeenCalledOnce();
    expect(h.setActiveView).not.toHaveBeenCalled();
    expect(h.openPanel).not.toHaveBeenCalled();
  });

  it("transfers opens the transfer panel in Agents", () => {
    const h = handlers();
    openNativeRoute("transfers", h);
    expect(h.setActiveView).toHaveBeenCalledWith("agents");
    expect(h.openPanel).toHaveBeenCalledWith("transfer");
    expect(h.openMemory).not.toHaveBeenCalled();
    expect(eosLocation()).toBe("eos:/");
  });

  it("an eos: location switches to Eos at that location", () => {
    const h = handlers();
    openNativeRoute("eos:/capabilities/github", h);
    expect(h.setActiveView).toHaveBeenCalledWith("eos");
    expect(eosLocation()).toBe("eos:/capabilities/github");
    expect(h.openMemory).not.toHaveBeenCalled();
    expect(h.openPanel).not.toHaveBeenCalled();
  });

  it("anything else does nothing", () => {
    const h = handlers();
    openNativeRoute(undefined, h);
    openNativeRoute("settings", h);
    expect(h.openMemory).not.toHaveBeenCalled();
    expect(h.setActiveView).not.toHaveBeenCalled();
    expect(h.openPanel).not.toHaveBeenCalled();
  });
});
