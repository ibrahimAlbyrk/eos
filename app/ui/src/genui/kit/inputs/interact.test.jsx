// Interaction without a DOM: useView() is pointed at a test runtime, the
// hook-free components are called as functions, and the handlers on the
// returned elements are invoked directly.

import { describe, it, expect, vi } from "vitest";
import { testRuntime, findElements } from "../data/testkit.jsx";
import restaurants from "../../../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";
import trip from "../../../../../../contracts/src/__tests__/fixtures/genui/trip.json";
import learn from "../../../../../../contracts/src/__tests__/fixtures/genui/learn.json";

const h = vi.hoisted(() => ({ rt: null }));
vi.mock("../../runtime/ViewContext.jsx", () => ({
  useView: () => h.rt.view,
  useItem: () => undefined,
  useSendPending: () => false,
  useSendFailure: () => null,
  ItemScope: ({ children }) => children,
  ViewProvider: ({ children }) => children,
}));

const { Filters } = await import("./Filters.jsx");
const { FilterEmpty } = await import("./FilterEmpty.jsx");
const { Segmented, Toggle, Stepper } = await import("./controls.jsx");
const { Checklist, Choice, Actions, submitForm } = await import("./choice.jsx");
const { ActionButton } = await import("../content/ActionButton.jsx");

const buttons = (el, cls) => findElements(el, (n) => n.type === "button" && String(n.props?.className ?? "").includes(cls));
const filtersLine = restaurants.ui.split("\n")[0];
const filterAttrs = { of: "places", chips: filtersLine.match(/chips="([^"]+)"/)[1], on: "0" };

describe("Filters toggling", () => {
  it("toggles a chip through the runtime and every lens sees it", () => {
    h.rt = testRuntime({ ...restaurants, ui: filtersLine });
    let chips = buttons(Filters({ attrs: filterAttrs }), "gv-fchip");
    expect(chips.map((c) => c.props["aria-pressed"])).toEqual([true, false, false, false, false, false]);
    chips[1].props.onClick(); // Deniz ürünü
    expect(h.rt.state._filters_places).toEqual([0, 1]);
    expect(h.rt.view.collection("places").every((p) => p.tags.includes("sea"))).toBe(true);
    chips = buttons(Filters({ attrs: filterAttrs }), "gv-fchip");
    expect(chips[1].props["aria-pressed"]).toBe(true);
    chips[0].props.onClick();
    expect(h.rt.state._filters_places).toEqual([1]);
  });

  it("a chip's filter may use || with either chip separator", () => {
    for (const chips of ["Cheap or great: price<=1 || rating>=4.6, Sea: tags~sea", "Cheap or great: price<=1 || rating>=4.6 | Sea: tags~sea"]) {
      h.rt = testRuntime({ ...restaurants, ui: `<Filters of="places" chips="${chips}"/>` });
      const btns = buttons(Filters({ attrs: { of: "places", chips } }), "gv-fchip");
      expect(btns.map((b) => b.props.title)).toEqual(["price<=1 || rating>=4.6", "tags~sea"]);
      btns[0].props.onClick();
      expect(h.rt.view.collection("places").map((p) => p.id)).toEqual(["moda", "lal", "ocak", "rihtim", "yel"]);
    }
  });

  it("the empty state clears every chip", () => {
    h.rt = testRuntime({ ...restaurants, ui: '<Filters of="places" chips="Nope: tags~zzz, Sea: tags~sea"/>' }, { state: { _filters_places: [0, 1] } });
    expect(h.rt.view.collection("places")).toEqual([]);
    // Drawn once, under the Filters chips; a lens's copy steps aside.
    expect(FilterEmpty({ of: "places" })).toBe(null);
    const fromFilters = findElements(Filters({ attrs: { of: "places", chips: "Nope: tags~zzz, Sea: tags~sea" } }), (n) => n.type === FilterEmpty);
    expect(fromFilters).toHaveLength(1);
    expect(fromFilters[0].props.standalone).toBe(true);
    const el = FilterEmpty({ of: "places", standalone: true });
    expect(el).not.toBe(null);
    const [clear] = buttons(el, "gv-btn");
    clear.props.onClick();
    expect(h.rt.state._filters_places).toEqual([]);
    expect(FilterEmpty({ of: "places", standalone: true })).toBe(null);
  });
});

describe("bound controls write view state", () => {
  it("Segmented picks by option value", () => {
    h.rt = testRuntime({ ...trip, ui: trip.ui.split("\n")[0] });
    const attrs = { bind: "day", options: "Cumartesi | Pazar", default: "Cumartesi" };
    const bar = findElements(Segmented({ attrs }), (n) => typeof n.props?.onPick === "function")[0];
    expect(bar.props.index).toBe(0);
    bar.props.onPick(1);
    expect(h.rt.state.day).toBe("Pazar");
    expect(h.rt.view.collection("stops", { where: "day == state.day" }).every((s) => s.day === "Pazar")).toBe(true);
    expect(findElements(Segmented({ attrs }), (n) => typeof n.props?.onPick === "function")[0].props.index).toBe(1);
  });

  it("Toggle and Stepper", () => {
    h.rt = testRuntime({ title: "t", summary: "s", ui: '<Toggle bind="view"/><Stepper bind="years" min="1" max="3" default="2"/>' });
    const input = findElements(Toggle({ attrs: { bind: "view", label: "View" } }), (n) => n.type === "input")[0];
    input.props.onChange({ target: { checked: true } });
    expect(h.rt.state.view).toBe(true);
    const sattrs = { bind: "years", min: "1", max: "3", default: "2" };
    buttons(Stepper({ attrs: sattrs }), "gv-stepper__btn")[1].props.onClick();
    expect(h.rt.state.years).toBe(3);
    const [dec, inc] = buttons(Stepper({ attrs: sattrs }), "gv-stepper__btn");
    expect(inc.props.disabled).toBe(true);
    const spin = findElements(Stepper({ attrs: sattrs }), (n) => n.props?.role === "spinbutton")[0];
    spin.props.onKeyDown({ key: "Home", preventDefault() {} });
    expect(h.rt.state.years).toBe(1);
    expect(dec.props.disabled).toBe(false);
  });

  it("Checklist ticks and unticks", () => {
    h.rt = testRuntime({ ...trip, ui: "" });
    const attrs = { bind: "packed", of: "packing" };
    let boxes = findElements(Checklist({ attrs }), (n) => n.type === "input");
    expect(boxes.map((b) => b.props.checked)).toEqual([true, false, false, false]);
    boxes[2].props.onChange();
    expect(h.rt.state.packed).toEqual(["a", "c"]);
    boxes = findElements(Checklist({ attrs }), (n) => n.type === "input");
    boxes[0].props.onChange();
    expect(h.rt.state.packed).toEqual(["c"]);
  });

  it("Choice locks after an answer and can be tried again", () => {
    h.rt = testRuntime({ ...learn, ui: "" });
    const line = learn.ui.split("\n").find((l) => l.startsWith("<Choice"));
    const options = JSON.parse(line.match(/options=\{(.*?)\}\s+answer/)[1]);
    const attrs = { bind: "quiz", options, answer: "1", explain: "x" };
    let opts = buttons(Choice({ attrs }), "gv-choice__opt");
    opts[2].props.onClick();
    expect(h.rt.state.quiz).toBe(options[2]);
    opts = buttons(Choice({ attrs }), "gv-choice__opt");
    expect(opts[2].props.className).toContain("is-wrong");
    expect(opts[1].props.className).toContain("is-right");
    opts[0].props.onClick(); // locked
    expect(h.rt.state.quiz).toBe(options[2]);
    const [again] = buttons(Choice({ attrs }), "gv-choice__again");
    again.props.onClick();
    expect(h.rt.state.quiz).toBe(null);
  });
});

describe("actions leave the view", () => {
  it("an Actions button sends its turn with the action payload", async () => {
    h.rt = testRuntime({ ...trip, ui: "" }, { state: { day: "Pazar" } });
    const el = Actions({ attrs: { ids: "calendar page" } });
    const [btn] = findElements(el, (n) => n.type === ActionButton);
    expect(btn.props.variant).toBe("primary");
    const rendered = ActionButton(btn.props);
    rendered.props.onClick({ stopPropagation() {} });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.rt.calls).toHaveLength(1);
    expect(h.rt.calls[0]).toMatchObject({ kind: "send", text: trip.actions.calendar.text, action: { actionId: "calendar", label: "Takvime ekle", state: { day: "Pazar" } } });
  });

  it("a Form submit sends the action and reports back", async () => {
    const spec = { title: "Book", summary: "s", actions: { book: { label: "Request booking", kind: "send", text: "Book for {state.party}" } }, ui: "" };
    h.rt = testRuntime(spec, { state: { party: 4 } });
    expect(await submitForm(h.rt.view, "book")).toEqual({ phase: "sent", reason: "" });
    expect(h.rt.calls[0].text).toBe("Book for 4");
    expect((await submitForm(h.rt.view, "nope")).phase).toBe("error");
  });
});
