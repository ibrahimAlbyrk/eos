import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderSpec } from "../data/testkit.jsx";
import { _reset } from "../../runtime/viewStateStore.js";
import { snap, optionIndex } from "./controls.jsx";
import { answerIndex, choiceMarks, actionVariants, checkedIds } from "./choice.jsx";
import { activeChips } from "./FilterEmpty.jsx";
import restaurants from "../../../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";
import trip from "../../../../../../contracts/src/__tests__/fixtures/genui/trip.json";
import learn from "../../../../../../contracts/src/__tests__/fixtures/genui/learn.json";

vi.mock("../../../lib/markdown.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, renderMarkdown: mod.markdownToHtml };
});

beforeEach(() => _reset());

const count = (html, needle) => html.split(needle).length - 1;
const bare = (ui, extra = {}) => ({ title: "t", summary: "s", ui, ...extra });

describe("Filters", () => {
  const ui = restaurants.ui.split("\n")[0];

  it("renders the chips, the on= chip pressed with a check, and the count", () => {
    const html = renderSpec({ ...restaurants, ui });
    expect(count(html, 'class="gv-fchip')).toBe(6);
    expect(html).toContain('class="gv-fchip is-on" aria-pressed="true"');
    expect(count(html, 'aria-pressed="false"')).toBe(5);
    expect(html).toMatch(/<svg[^>]*class="gv-icon"/);
    const open = restaurants.data.places.filter((p) => p.status !== "closed" && p.hours?.closed !== true).length;
    expect(html).toContain(`>${open === 6 ? "6" : `${open} of 6`}<`);
  });

  it("follows chips stored in state", () => {
    const html = renderSpec({ ...restaurants, ui }, { state: { _filters_places: [1, 3] } });
    expect(count(html, "gv-fchip is-on")).toBe(2);
    const n = restaurants.data.places.filter((p) => p.tags.includes("sea") && p.price <= 2).length;
    expect(html).toContain(`>${n} of 6<`);
  });
});

describe("controls", () => {
  it("Segmented uses the shared glass switch, default selected", () => {
    const html = renderSpec({ ...trip, ui: trip.ui.split("\n")[0] });
    expect(count(html, 'class="gv-seg-opt')).toBe(2);
    expect(html).toContain('class="gv-seg-opt is-on"');
    expect(html).toContain(">Cumartesi<");
    expect(html).toContain('role="group"');
  });

  it("Toggle is a labelled switch", () => {
    const html = renderSpec(bare('<Toggle bind="view" label="Only places with a view" default/>'));
    expect(html).toContain('role="switch"');
    expect(html).toContain('checked=""');
    expect(html).toContain(">Only places with a view<");
  });

  it("Slider shows its live label with prefix/format", () => {
    const html = renderSpec(bare('<Slider bind="save" label="Monthly saving" min="500" max="10000" step="250" default="3000" prefix="₺"/>'));
    expect(html).toContain(">Monthly saving<");
    expect(html).toMatch(/>₺3[.,]000</);
    expect(html).toContain('step="250"');
    expect(html).toContain('value="3000"');
  });

  it("Stepper shows − value + and disables the bound end", () => {
    const html = renderSpec(bare('<Stepper bind="years" label="Years" min="1" max="30" default="1" unit="yr"/>'));
    expect(html).toContain('aria-label="Decrease Years" disabled=""');
    expect(html).not.toContain('aria-label="Increase Years" disabled=""');
    expect(html).toContain('role="spinbutton"');
    expect(html).toContain('<span class="gv-stepper__unit">yr</span>');
  });

  it("Select and Field are real labelled inputs", () => {
    const sel = renderSpec(bare('<Select bind="party" label="Party size" options="2 people | 4 people | 6 people" default="4 people"/>'));
    expect(sel).toMatch(/<label for="[^"]+">Party size<\/label>/);
    expect(count(sel, "<option")).toBe(3);
    expect(sel).toMatch(/<option value="1" selected="">4 people<\/option>/);
    const field = renderSpec(bare('<Field bind="note" label="Note for the venue" placeholder="Window table if possible"/>'));
    expect(field).toContain('placeholder="Window table if possible"');
    expect(field).toContain('type="text"');
    const area = renderSpec(bare('<Field bind="note" type="multiline"/>'));
    expect(area).toContain("<textarea");
  });

  it("pure helpers: snap and option lookup", () => {
    expect(snap(3120, 500, 10000, 250)).toBe(3000);
    expect(snap(99999, 500, 10000, 250)).toBe(10000);
    expect(snap(0.123, 0, 1, 0.05)).toBe(0.1);
    expect(optionIndex([{ label: "A", value: "a" }, { label: "B", value: "b" }], "B")).toBe(1);
    expect(optionIndex([{ label: "A", value: "a" }], "zz")).toBe(-1);
  });
});

describe("Checklist", () => {
  it("seeds ticks from done: true and counts n / m (Trip board)", () => {
    const html = renderSpec({ ...trip, ui: '<Checklist bind="packed" of="packing" title="Yanına al"/>' });
    expect(html).toContain('<span class="gv-check__title">Yanına al</span>');
    expect(html).toContain('aria-label="1 of 4 done">1 / 4<');
    expect(count(html, 'class="is-done"')).toBe(1);
    expect(count(html, 'type="checkbox"')).toBe(4);
  });

  it("stored ticks win over the seed; items= labels work too", () => {
    const html = renderSpec({ ...trip, ui: '<Checklist bind="packed" of="packing"/>' }, { state: { packed: ["b", "c"] } });
    expect(count(html, 'class="is-done"')).toBe(2);
    const labels = renderSpec(bare('<Checklist bind="todo" items="Confirm headcount | Book the table | Share the plan"/>'));
    expect(labels).toContain(">Book the table<");
    expect(checkedIds(undefined, [{ id: "a", done: true }, { id: "b" }])).toEqual(new Set(["a"]));
    expect(checkedIds([], [{ id: "a", done: true }])).toEqual(new Set());
  });
});

describe("Choice", () => {
  const ui = learn.ui.split("\n").find((l) => l.startsWith("<Choice"));

  it("renders the quiz with its question and options", () => {
    const html = renderSpec({ ...learn, ui });
    expect(html).toContain(">Quick check<");
    expect(html).toContain("push edilmiş bir branch");
    expect(html.match(/class="gv-choice__opt( [^"]*)?"/g)).toHaveLength(3);
    expect(html).not.toContain("gv-choice__feedback");
  });

  it("reveals right and wrong once answered, with the explanation", () => {
    const wrong = JSON.parse(ui.match(/options=\{(.*?)\}\s+answer/)[1])[0];
    const html = renderSpec({ ...learn, ui }, { state: { quiz: wrong } });
    expect(html).toContain("gv-choice__opt is-wrong");
    expect(html).toContain("gv-choice__opt is-right");
    expect(html).toContain(">Not quite.<");
    expect(html).toContain("Push edilmiş commit");
  });

  it("answer by index or label; marks", () => {
    const opts = [{ label: "Yes", value: "Yes" }, { label: "No", value: "No" }];
    expect(answerIndex(opts, "1")).toBe(1);
    expect(answerIndex(opts, "No")).toBe(1);
    expect(answerIndex(opts, "7")).toBe(-1);
    expect(answerIndex(opts, undefined)).toBe(-1);
    expect(choiceMarks(opts, 0, 1)).toEqual(["wrong", "right"]);
    expect(choiceMarks(opts, 1, 1)).toEqual(["", "right"]);
    expect(choiceMarks(opts, 0, -1)).toEqual(["picked", ""]);
    expect(choiceMarks(opts, -1, 1)).toEqual(["", ""]);
  });
});

describe("Form and Actions", () => {
  const spec = {
    title: "Book",
    summary: "s",
    actions: {
      book: { label: "Request booking", kind: "send", primary: true, text: "Book for {state.party}" },
      call: { label: "Call", kind: "open", href: "tel:+90" },
      more: { label: "More", kind: "send", primary: true },
      extra: { label: "Extra", kind: "send", primary: true },
      reset: { label: "Reset", kind: "set", set: { party: 2 } },
    },
  };

  it("Form wraps its inputs and submits with the action's label", () => {
    const html = renderSpec({ ...spec, ui: '<Form action="book"><Stepper bind="party" label="Party" min="1"/><Field bind="note" label="Note"/></Form>' });
    expect(html).toContain('<form class="gv-form" novalidate="">');
    expect(html).toContain('role="spinbutton"');
    expect(html).toContain('type="submit" class="gv-btn gv-btn-primary"');
    expect(html).toContain(">Request booking<");
  });

  it("Actions: at most two primary fills, set actions are ghost buttons", () => {
    expect(actionVariants(["book", "call", "more", "extra", "reset"], spec.actions)).toEqual(["primary", "glass", "primary", "glass", "ghost"]);
    const html = renderSpec({ ...spec, ui: '<Actions ids="book call more extra reset" align="end"/>' });
    expect(html).toContain("gv-actbar gv-actbar--end");
    expect(count(html, "gv-btn-primary")).toBe(2);
    expect(html).toContain("gv-kbtn-ghost");
    expect(count(html, "data-action=")).toBe(5);
  });

  it("Actions from the Trip fixture", () => {
    const html = renderSpec({ ...trip, ui: '<Actions ids="calendar page meyhane"/>' });
    expect(html).toContain(">Takvime ekle<");
    expect(count(html, "gv-btn-primary")).toBe(1);
  });
});

describe("activeChips", () => {
  it("reads the runtime's chip list and plain index shapes", () => {
    expect(activeChips([{ index: 0, on: true }, { index: 1, on: false }, { index: 2, on: true }])).toEqual([0, 2]);
    expect(activeChips([1, 3])).toEqual([1, 3]);
    expect(activeChips(new Set([2]))).toEqual([2]);
    expect(activeChips({ 0: true, 1: false })).toEqual([0]);
    expect(activeChips(null)).toEqual([]);
  });
});
