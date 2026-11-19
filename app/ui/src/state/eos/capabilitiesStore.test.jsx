import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../api/routes.js";
import { notify } from "../../lib/notify.js";
import { fixtureTransport, setEosTransport } from "./transport.js";
import {
  _resetCapabilities, applyCapabilitiesChange, checkCapability, ensureCapabilitiesLoaded, loadCapability, refreshCapabilities,
  removeCapability, resyncCapabilities, rollbackCapability, rowOf, setCapabilityEnabled, useCapabilities,
} from "./capabilitiesStore.js";
import { applyEosEvent, EOS_TOPICS } from "./live.js";
import samples from "../../views/eos/gallery/sample/capabilities.json";

const byId = Object.fromEntries(samples.map((d) => [d.id, d]));
const reads = (details = samples) => ({
  [ROUTES.capabilities]: details.map(rowOf),
  ...Object.fromEntries(details.map((d) => [ROUTES.capability(d.id), d])),
});
const DEV_RUN = { ok: false, status: 403, body: { error: "refused in a dev run: this request can start an agent" } };

// A transport that answers reads from `paths` and writes with `sent`, and records every call.
function recording(paths, sent = async () => ({ ok: true, status: 200, body: {} })) {
  const fixture = fixtureTransport(paths);
  return { get: vi.fn(fixture.get), send: vi.fn(sent) };
}

// The store's state as a component reads it.
function current() {
  let read;
  function Probe() {
    read = useCapabilities();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read;
}

beforeEach(() => _resetCapabilities());
afterEach(() => {
  setEosTransport(null);
  vi.restoreAllMocks();
});

describe("the capability list", () => {
  it("loads once, after the first paint", async () => {
    const t = recording(reads());
    setEosTransport(t);
    ensureCapabilitiesLoaded();
    ensureCapabilitiesLoaded();
    await vi.waitFor(() => expect(current().list).toHaveLength(6));
    expect(t.get).toHaveBeenCalledTimes(1);
    expect(current().list[0]).toEqual(rowOf(byId.github));
  });

  it("says it could not load, and keeps the last list when a later read fails", async () => {
    setEosTransport(fixtureTransport({}));
    await refreshCapabilities();
    expect(current()).toMatchObject({ list: null, listFailed: true });

    setEosTransport(fixtureTransport(reads()));
    await refreshCapabilities();
    setEosTransport(fixtureTransport({}));
    await refreshCapabilities();
    expect(current()).toMatchObject({ listFailed: false });
    expect(current().list).toHaveLength(6);
  });
});

describe("capabilities:change", () => {
  it("is Eos's topic, routed before useLive's fallthrough", () => {
    expect(EOS_TOPICS).toContain("capabilities:change");
    expect(applyEosEvent("worker:change", {})).toBe(false);
  });

  it("shows the new state at once, then refetches that one capability, never the list", async () => {
    setEosTransport(fixtureTransport(reads()));
    await refreshCapabilities();
    const signedIn = { ...byId.github, state: "ready", stateCode: undefined, accountLabel: "octocat" };
    const t = recording(reads([signedIn]));
    setEosTransport(t);

    expect(applyEosEvent("capabilities:change", { id: "github", state: "ready" })).toBe(true);
    expect(current().list[0]).toMatchObject({ id: "github", state: "ready", stateCode: undefined });
    await vi.waitFor(() => expect(current().list[0].accountLabel).toBe("octocat"));

    expect(t.get.mock.calls).toEqual([[ROUTES.capability("github")]]);
    expect(current().details.github).toEqual(signedIn);
    expect(current().list.map((r) => r.id)).toEqual(samples.map((d) => d.id));
  });

  it("adds a capability the list did not have, and drops one the core no longer has", async () => {
    setEosTransport(fixtureTransport(reads(samples.slice(0, 2))));
    await refreshCapabilities();
    setEosTransport(fixtureTransport(reads(samples.slice(0, 3))));

    applyCapabilitiesChange({ id: "linear-issues", state: "needs_sign_in", stateCode: "http_401" });
    await vi.waitFor(() => expect(current().list.map((r) => r.id)).toEqual(["github", "sms-messages", "linear-issues"]));

    setEosTransport(fixtureTransport(reads(samples.slice(1, 3))));
    applyCapabilitiesChange({ id: "github", state: "needs_setup" });
    await vi.waitFor(() => expect(current().list.map((r) => r.id)).toEqual(["sms-messages", "linear-issues"]));
    expect(current().failed.github).toBe("gone");
  });

  it("reads nothing while nothing is loaded", () => {
    const t = recording(reads());
    setEosTransport(t);
    applyCapabilitiesChange({ id: "github", state: "ready" });
    applyCapabilitiesChange(null);
    expect(t.get).not.toHaveBeenCalled();
  });

  it("lands only the latest answer for a capability", async () => {
    const answers = [];
    setEosTransport({ get: () => new Promise((resolve) => answers.push(resolve)), send: async () => null });
    const first = loadCapability("weather");
    const second = loadCapability("weather");
    answers[1]({ ok: true, status: 200, body: { ...byId.weather, state: "ready" } });
    answers[0]({ ok: true, status: 200, body: byId.weather });
    await Promise.all([first, second]);
    expect(current().details.weather.state).toBe("ready");
  });

  it("refetches the list and every open capability on resync", async () => {
    const t = recording(reads());
    setEosTransport(t);
    ensureCapabilitiesLoaded();
    await vi.waitFor(() => expect(current().list).not.toBeNull());
    await loadCapability("weather");
    t.get.mockClear();
    resyncCapabilities();
    expect(t.get.mock.calls).toEqual([[ROUTES.capabilities], [ROUTES.capability("weather")]]);
  });
});

describe("writes", () => {
  beforeEach(async () => {
    setEosTransport(fixtureTransport(reads()));
    await refreshCapabilities();
    await loadCapability("rss-feeds");
  });

  it("put the answered row in the list and in the open detail", async () => {
    const checked = { ...rowOf(byId["rss-feeds"]), state: "ready" };
    delete checked.stateCode;
    const t = recording(reads(), async () => ({ ok: true, status: 200, body: checked }));
    setEosTransport(t);

    await checkCapability("rss-feeds");
    await setCapabilityEnabled("notify", true);
    await setCapabilityEnabled("notify", false);
    await rollbackCapability("rss-feeds", "1.4.0");

    expect(t.send.mock.calls).toEqual([
      ["POST", ROUTES.capabilityCheck("rss-feeds"), undefined],
      ["POST", ROUTES.capabilityEnable("notify"), {}],
      ["POST", ROUTES.capabilityDisable("notify"), {}],
      ["POST", ROUTES.capabilityRollback("rss-feeds"), { version: "1.4.0" }],
    ]);
    expect(current().list.find((r) => r.id === "rss-feeds")).toEqual(checked);
    expect(current().details["rss-feeds"]).toMatchObject({ state: "ready", versions: byId["rss-feeds"].versions });
    expect(current().details["rss-feeds"]).not.toHaveProperty("stateCode");
  });

  it("remove drops the capability once the core moved it to the trash", async () => {
    const t = recording(reads(), async () => ({ ok: true, status: 200, body: { ok: true } }));
    setEosTransport(t);
    expect(await removeCapability("rss-feeds")).toBe(true);
    expect(t.send).toHaveBeenCalledWith("DELETE", ROUTES.capability("rss-feeds"), undefined);
    expect(current().list.map((r) => r.id)).not.toContain("rss-feeds");
    expect(current().details).not.toHaveProperty("rss-feeds");
  });

  it("a dev run's refusal is noted for the screen, not reported as a failure", async () => {
    const error = vi.spyOn(notify, "error");
    setEosTransport(recording(reads(), async () => DEV_RUN));
    await checkCapability("rss-feeds");
    expect(current().devRun).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(current().list.find((r) => r.id === "rss-feeds").state).toBe("broken");
  });

  it("any other failure is a toast with the core's reason", async () => {
    const error = vi.spyOn(notify, "error").mockReturnValue(undefined);
    setEosTransport(recording(reads(), async () => ({ ok: false, status: 400, body: { error: "notify is a built-in capability: it cannot be removed" } })));
    expect(await removeCapability("notify")).toBe(false);
    expect(error).toHaveBeenCalledWith("notify is a built-in capability: it cannot be removed", { title: "Capabilities" });
    expect(current().devRun).toBe(false);
    expect(current().list.map((r) => r.id)).toContain("notify");
  });
});
