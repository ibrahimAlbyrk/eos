import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseMarkup } from "../../../../../contracts/src/genui/markup.ts";
import restaurants from "../../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";
import trip from "../../../../../contracts/src/__tests__/fixtures/genui/trip.json";
import tests from "../../../../../contracts/src/__tests__/fixtures/genui/tests.json";
import {
  SEND_COOLDOWN_MS, _resetSendLocks, actionClientMsgId, bindItem, createViewRuntime, inferEntityKind, isSendPending,
  mapsHref, scanMarkup, toneVars,
} from "./runtime.js";

const VIEW = "v_abcdefghijkl";

// A runtime over a fixture with a live state map, like ViewProvider builds.
function runtimeFor(spec, { host, state: initial = {}, viewId = VIEW, live = false } = {}) {
  let state = { ...initial };
  let selection = {};
  const scan = scanMarkup(parseMarkup(spec.ui).nodes);
  const make = () => createViewRuntime({
    viewId, viewTitle: spec.title, spec, scan, state, selection, host,
    ...(live ? { liveState: () => state } : {}),
    setState: (k, v) => { state = { ...state, [k]: v }; },
    select: (name, id) => { selection = { ...selection, [name]: id }; },
  });
  return { get rt() { return make(); }, get state() { return state; } };
}

const fakeHost = () => ({
  send: vi.fn(async () => ({ ok: true, status: 202, body: {} })),
  prefill: vi.fn(),
  openUrl: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(async () => {}),
});

describe("scanMarkup", () => {
  it("finds the Filters of a collection with the chips that start on", () => {
    const { filters } = scanMarkup(parseMarkup(restaurants.ui).nodes);
    const f = filters.get("places");
    expect(f.chips.map((c) => c.label)).toEqual(["Şu an açık", "Deniz ürünü", "Meyhane", "₺–₺₺", "4.5+", "Rezervasyon alıyor"]);
    expect(f.on).toEqual([0]);
    expect(f.key).toBe("_filters_places");
  });

  it("seeds bound scalar inputs from default= (or the first option)", () => {
    expect(scanMarkup(parseMarkup(trip.ui).nodes).defaults).toEqual({ day: "Cumartesi" });
    const { defaults } = scanMarkup(parseMarkup(
      '<Select bind="party" options="2 kişi | 4 kişi"/><Toggle bind="veg" default/><Slider bind="amt" min="10" max="90"/><Stepper bind="n"/><Field bind="note" default="hi"/><Field bind="empty"/>',
    ).nodes);
    expect(defaults).toEqual({ party: "2 kişi", veg: true, amt: 10, n: 0, note: "hi" });
  });
});

describe("collections", () => {
  it("applies the Filters chips that are on in every lens", () => {
    const v = runtimeFor(restaurants);
    // "Şu an açık" (open) is on at start: Sofra Moda (closed today) drops out.
    expect(v.rt.collection("places").map((p) => p.id)).toEqual(["moda", "lal", "ocak", "rihtim", "yel"]);
    expect(v.rt.allItems("places")).toHaveLength(6);
    expect(v.rt.filters("places")[0]).toMatchObject({ label: "Şu an açık", on: true });
  });

  it("toggles chips into state; chips combine with AND", () => {
    const v = runtimeFor(restaurants);
    v.rt.toggleFilter("places", 1); // Deniz ürünü: tags~sea
    expect(v.state._filters_places).toEqual([0, 1]);
    expect(v.rt.collection("places").map((p) => p.id)).toEqual(["moda", "lal"]);
    v.rt.toggleFilter("places", 0);
    expect(v.rt.collection("places").map((p) => p.id)).toEqual(["moda", "lal"]);
    v.rt.toggleFilter("places", 1);
    expect(v.rt.collection("places")).toHaveLength(6);
  });

  it("applies an element's lens: skip, sort, limit, where over state", () => {
    const v = runtimeFor(restaurants);
    expect(v.rt.collection("places", { skip: "moda" }).map((p) => p.id)).toEqual(["lal", "ocak", "rihtim", "yel"]);
    expect(v.rt.collection("places", { sort: "-rating", limit: "2" }).map((p) => p.id)).toEqual(["moda", "lal"]);
    expect(v.rt.collection("places", { sort: "price" })[0].price).toBe(1);
    const t = runtimeFor(trip);
    const sat = t.rt.collection("stops", { where: "day == state.day" });
    expect(sat.length).toBeGreaterThan(0);
    expect(sat.every((s) => s.day === "Cumartesi")).toBe(true);
    t.rt.setState("day", "Pazar");
    expect(t.rt.collection("stops", { where: "day == state.day" }).every((s) => s.day === "Pazar")).toBe(true);
  });

  it("templates and expressions read item, state and data", () => {
    const t = runtimeFor(trip);
    expect(t.rt.evalExpr("sum(budget.amount)")).toBe(trip.data.budget.reduce((a, b) => a + b.amount, 0));
    expect(t.rt.getState("day")).toBe("Cumartesi");
    const r = runtimeFor(restaurants).rt;
    const moda = r.allItems("places")[0];
    expect(r.template("{cuisine} · {area}", moda)).toBe("Meyhane · Deniz ürünü · Moda");
    const bound = bindItem(r, moda);
    expect(bound.template("{name}")).toBe("Moda Kıyı");
    expect(bound.item).toBe(moda);
  });

  it("selection is per collection", () => {
    const v = runtimeFor(restaurants);
    expect(v.rt.selected("places")).toBe(null);
    v.rt.select("places", "lal");
    expect(v.rt.selected("places")).toBe("lal");
  });
});

describe("runAction", () => {
  beforeEach(() => _resetSendLocks());

  it("send: templated text + the action payload, queued when busy", async () => {
    const host = fakeHost();
    const v = runtimeFor(restaurants, { host });
    const moda = v.rt.allItems("places")[0];
    const r = await v.rt.runAction("book", { item: moda });
    expect(r.ok).toBe(true);
    expect(host.send).toHaveBeenCalledTimes(1);
    const [text, opts] = host.send.mock.calls[0];
    expect(text).toBe("Moda Kıyı için bu akşam 2 kişilik masa ayırt");
    expect(opts.queueWhenBusy).toBe(true);
    expect(opts.clientMsgId).toMatch(/^gv:v_abcdefghijkl:[0-9a-z]+:[0-9a-z]+$/);
    expect(opts.action).toEqual({
      viewId: VIEW,
      actionId: "book",
      // The chip names the item, like the board's round trip.
      label: "Masa ayırt · Moda Kıyı",
      viewTitle: "Kadıköy'de bu akşam",
      item: "moda",
    });
  });

  it("send: an action without text sends its label, with the user's state minus kit bookkeeping", async () => {
    const host = fakeHost();
    const v = runtimeFor(restaurants, { host, state: { _filters_places: [0, 2], _tabs_3_5: 1, party: 4 } });
    await v.rt.runAction("seaOnly");
    const [text, opts] = host.send.mock.calls[0];
    expect(text).toBe("Sadece deniz manzaralılar");
    expect(opts.action.state).toEqual({ party: 4 });
    expect(opts.action.item).toBeUndefined();
  });

  it("send: no state key when only kit bookkeeping is set", async () => {
    const host = fakeHost();
    const v = runtimeFor(restaurants, { host, state: { _filters_places: [0] } });
    await v.rt.runAction("seaOnly");
    expect(host.send.mock.calls[0][1].action).not.toHaveProperty("state");
  });

  it("clearFilters turns every chip of a collection off in one write", () => {
    const v = runtimeFor(restaurants, { state: { _filters_places: [0, 1] } });
    v.rt.clearFilters("places");
    v.rt.clearFilters("nope");
    expect(v.state).toEqual({ _filters_places: [] });
    expect(v.rt.filters("places").some((c) => c.on)).toBe(false);
  });

  it("toneVars carries the tone's own on-color and ink", () => {
    expect(toneVars("amber")["--gv-on"]).toBe("#1f1303");
    expect(toneVars("violet")["--gv-ink"]).toBe("#c6aefd");
    expect(toneVars("nope")["--gv-on"]).toBe("#0a1725");
  });

  it("send: one at a time per view, and never before the view has its id", async () => {
    let release;
    const host = fakeHost();
    host.send.mockImplementation(() => new Promise((res) => { release = () => res({ ok: true }); }));
    const v = runtimeFor(tests, { host });
    const first = v.rt.runAction("rerunFailed");
    const second = await v.rt.runAction("fixAll");
    expect(second).toEqual({ ok: false, reason: "busy" });
    release();
    expect((await first).ok).toBe(true);
    expect(host.send).toHaveBeenCalledTimes(1);

    const local = runtimeFor(tests, { host, viewId: "local:toolu_1" });
    expect((await local.rt.runAction("rerunFailed")).ok).toBe(false);
  });

  it("send: the lock outlasts the POST, so a double click after a fast answer still sends once", async () => {
    vi.useFakeTimers();
    try {
      const host = fakeHost();
      const v = runtimeFor(tests, { host });
      expect((await v.rt.runAction("rerunFailed")).ok).toBe(true);
      expect(isSendPending(VIEW)).toBe(true);
      expect(await v.rt.runAction("rerunFailed")).toEqual({ ok: false, reason: "busy" });
      vi.advanceTimersByTime(SEND_COOLDOWN_MS + 1);
      expect(isSendPending(VIEW)).toBe(false);
      expect((await v.rt.runAction("rerunFailed")).ok).toBe(true);
      expect(host.send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("send: a failed send releases at once so the user can retry", async () => {
    const host = fakeHost();
    host.send.mockResolvedValueOnce({ ok: false, status: 400, body: { error: "state too big" } });
    const v = runtimeFor(tests, { host });
    expect(await v.rt.runAction("rerunFailed")).toEqual({ ok: false, reason: "state too big" });
    expect(isSendPending(VIEW)).toBe(false);
    expect((await v.rt.runAction("rerunFailed")).ok).toBe(true);
  });

  it("send: the same view, action and item share an idempotency key within a few seconds", () => {
    const t = 1_760_000_000_000;
    expect(actionClientMsgId(VIEW, "book", "moda", t)).toBe(actionClientMsgId(VIEW, "book", "moda", t + 100));
    expect(actionClientMsgId(VIEW, "book", "moda", t)).not.toBe(actionClientMsgId(VIEW, "book", "lal", t));
    expect(actionClientMsgId(VIEW, "book", "moda", t)).not.toBe(actionClientMsgId(VIEW, "route", "moda", t));
    expect(actionClientMsgId(VIEW, "book", "moda", t)).not.toBe(actionClientMsgId(VIEW, "book", "moda", t + 60_000));
    expect(actionClientMsgId(VIEW, "x".repeat(64), { a: 1 }, t).length).toBeLessThanOrEqual(128);
  });

  it("send: reads the state as it is at the click, not as the runtime was built (set, then send)", async () => {
    const host = fakeHost();
    const spec = {
      title: "Pick", summary: "s", data: {},
      actions: { choose: { label: "Go with {state.pick}", kind: "send", text: "Let's use {state.pick}" } },
      ui: '<Choice bind="pick" options="Merge | Rebase" action="choose"/>',
    };
    const v = runtimeFor(spec, { host, live: true });
    const rt = v.rt; // built before the pick, like the render the click handler closes over
    rt.setState("pick", "Rebase");
    await rt.runAction("choose");
    const [text, opts] = host.send.mock.calls[0];
    expect(text).toBe("Let's use Rebase");
    expect(opts.action.label).toBe("Go with Rebase");
    expect(opts.action.state).toEqual({ pick: "Rebase" });
  });

  it("send: the chip label is templated like the button, and names the item only when it doesn't already", async () => {
    const host = fakeHost();
    const spec = {
      title: "x", summary: "s",
      data: { items: [{ id: "a", name: "Alpha" }] },
      actions: { book: { label: "Book {name}", kind: "send" }, plain: { label: "Re-run this", kind: "send" } },
      ui: "<Text>hi</Text>",
    };
    const v = runtimeFor(spec, { host });
    const item = spec.data.items[0];
    await v.rt.runAction("book", { item });
    expect(host.send.mock.calls[0][0]).toBe("Book Alpha");
    expect(host.send.mock.calls[0][1].action.label).toBe("Book Alpha");
    _resetSendLocks();
    await v.rt.runAction("plain", { item });
    expect(host.send.mock.calls[1][1].action.label).toBe("Re-run this · Alpha");
  });

  it("open: web links to the browser panel, maps: to a maps link, paths to the file panel", async () => {
    const host = fakeHost();
    const v = runtimeFor(restaurants, { host });
    const moda = v.rt.allItems("places")[0];
    await v.rt.runAction("menu", { item: moda });
    expect(host.openUrl).toHaveBeenCalledWith("https://modakiyi.example/menu");
    await v.rt.runAction("route", { item: moda });
    expect(host.openUrl).toHaveBeenLastCalledWith("https://maps.apple.com/?daddr=40.981,29.025");
    const t = runtimeFor(tests, { host });
    await t.rt.runAction("log");
    expect(host.openFile).toHaveBeenCalledWith("/tmp/eos-test-81f2/run.log", undefined);
    // An item with no url opens nothing.
    expect((await v.rt.runAction("menu", { item: v.rt.allItems("places")[2] })).ok).toBe(false);
  });

  it("prefill, copy and set stay on this side", async () => {
    const host = fakeHost();
    const spec = {
      title: "x",
      data: { items: [{ id: "a", name: "Alpha" }] },
      actions: {
        draft: { label: "Draft", kind: "prefill", text: "Tell me about {name}" },
        cp: { label: "Copy", kind: "copy", text: "{name}" },
        pick: { label: "Pick", kind: "set", set: { chosen: "{id}", n: 2 } },
      },
      ui: "<Text>hi</Text>",
      summary: "s",
    };
    const v = runtimeFor(spec, { host });
    const item = spec.data.items[0];
    await v.rt.runAction("draft", { item });
    expect(host.prefill).toHaveBeenCalledWith("Tell me about Alpha");
    await v.rt.runAction("cp", { item });
    expect(host.copy).toHaveBeenCalledWith("Alpha");
    await v.rt.runAction("pick", { item });
    expect(v.state).toEqual({ chosen: "a", n: 2 });
    expect(host.send).not.toHaveBeenCalled();
    expect((await v.rt.runAction("nope")).ok).toBe(false);
  });
});

describe("helpers", () => {
  it("tone vars come from the tone, blue by default", () => {
    expect(toneVars("red")["--gv-accent"]).toBe("#f4877f");
    expect(toneVars("nope")["--gv-accent"]).toBe("#67affd");
    expect(toneVars("teal")["--gv-soft"]).toBe("rgba(38, 193, 200, 0.22)");
  });

  it("infers an entity kind from its fields when type is missing", () => {
    expect(inferEntityKind({ type: "Event" })).toBe("Event");
    expect(inferEntityKind({ geo: [1, 2] })).toBe("Place");
    expect(inferEntityKind({ path: "a.ts" })).toBe("File");
    expect(inferEntityKind({ label: "x" })).toBe("Generic");
  });

  it("maps: links open as Apple Maps", () => {
    expect(mapsHref("maps:Moda Kıyı")).toBe("https://maps.apple.com/?q=Moda%20K%C4%B1y%C4%B1");
  });
});
