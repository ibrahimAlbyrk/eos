import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../api/routes.js";
import { fixtureTransport, setEosTransport } from "./transport.js";
import { ensureEosStatusLoaded, isEosShown, probeEosStatus, useEosShown } from "./eosStatusStore.js";
import routinesEmpty from "../../views/eos/gallery/sample/routines-empty.json";

const served = () => fixtureTransport({ [ROUTES.routines]: routinesEmpty });
const answering = (status, body) => ({ get: async () => ({ ok: status < 300, status, body }), send: async () => null });

function Shown() {
  return useEosShown() ? "shown" : "hidden";
}

afterEach(() => {
  setEosTransport(null);
  vi.unstubAllGlobals();
});

describe("eosStatusStore", () => {
  it("shows Eos when the routine list answers 200, even an empty one", async () => {
    setEosTransport(served());
    await probeEosStatus();
    expect(isEosShown()).toBe(true);
    expect(renderToStaticMarkup(<Shown />)).toBe("shown");
  });

  it("hides Eos when the core has no routines route (404)", async () => {
    setEosTransport(served());
    await probeEosStatus();
    setEosTransport(fixtureTransport({}));
    await probeEosStatus();
    expect(isEosShown()).toBe(false);
    expect(renderToStaticMarkup(<Shown />)).toBe("hidden");
  });

  it("hides Eos when the routines feature failed to start (503 feature_failed)", async () => {
    setEosTransport(served());
    await probeEosStatus();
    setEosTransport(answering(503, { error: "the routines feature could not start", code: "feature_failed" }));
    await probeEosStatus();
    expect(isEosShown()).toBe(false);
  });

  it("hides Eos when the core cannot be reached", async () => {
    setEosTransport(served());
    await probeEosStatus();
    setEosTransport(null);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await probeEosStatus();
    expect(isEosShown()).toBe(false);
  });

  it("probes once, however often it is asked", async () => {
    const get = vi.fn().mockResolvedValue({ ok: true, status: 200, body: [] });
    setEosTransport({ get, send: async () => null });
    ensureEosStatusLoaded();
    ensureEosStatusLoaded();
    await vi.waitFor(() => expect(isEosShown()).toBe(true));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(ROUTES.routines);
  });
});
