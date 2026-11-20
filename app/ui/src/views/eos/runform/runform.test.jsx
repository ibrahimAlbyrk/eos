import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { _resetRoutines, loadRoutine, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { _resetRuns, startRun } from "../../../state/eos/runsStore.js";
import { _resetRunSheet, open, registerHost, useRunSheet } from "../../../state/eos/runSheetStore.js";
import { _resetEosNav, eosLocation } from "../nav/eosNav.js";
import { comboKey, withChosen } from "./CandidateCombobox.jsx";
import { holdsEnter } from "./RunForm.jsx";
import { firstTime, laterAt, whenWords } from "./LaterPicker.jsx";
import { _resetKeptForms, keepForm, RunSheet, sheetEscape, sheetPlace, sheetStyle } from "./RunSheet.jsx";
import { initialForm } from "./runFormModel.js";
import routines from "../gallery/sample/routines.json";
import routineDetail from "../gallery/sample/routine-detail.json";

const bindings = vi.hoisted(() => []);
vi.mock("../../../keymap/useKeymap.js", () => ({ useGlobalKeymap: () => {}, useKeybinding: (b) => { bindings.push(b); } }));

const PR = routines[0];
const ITEM = { kind: "github.pull_request", key: "github:pr:acme/game#470@ab12", title: "Rework shop carousel paging", untrusted: true };
const reads = { [ROUTES.routines]: routines, [ROUTES.routine(PR.id)]: routineDetail };

function sheet() {
  bindings.length = 0;
  return renderToStaticMarkup(<RunSheet />);
}

function recording(sent) {
  const fixture = fixtureTransport(reads);
  return { get: vi.fn(fixture.get), send: vi.fn(sent) };
}

// A key as the keymap would pass it: the binding that takes it, run.
function press(key, extra = {}) {
  const e = { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: { tagName: "BODY", getAttribute: () => null }, preventDefault: vi.fn(), ...extra };
  const best = bindings.filter((b) => b.match(e)).reduce((a, b) => (!a || (b.priority ?? 0) >= (a.priority ?? 0) ? b : a), null);
  best?.run({}, e);
  return Boolean(best);
}

function current() {
  let read;
  function Probe() {
    read = useRunSheet();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return read;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  _resetRunSheet();
  _resetRoutines();
  _resetRuns();
  _resetEosNav();
  _resetKeptForms();
  setEosTransport(fixtureTransport(reads));
  await refreshRoutines();
});
afterEach(() => setEosTransport(null));

describe("the run sheet", () => {
  it("draws nothing until asked, then the fields in the design's order", async () => {
    registerHost();
    expect(sheet()).toBe("");
    open({ routineId: PR.id, anchor: null });
    await loadRoutine(PR.id);
    const html = sheet();
    const order = [
      '<h1 class="eos-runform__title">Run PR Review</h1>',
      "Reviews each new pull request",
      'for="runform-item">Pull request</label>',
      'role="combobox"',
      "Empty takes the latest",
      'id="runform-opt-depth"',
      ">Note for this run</label>",
      'id="runform-result">Result</span>',
      ">As usual</button>", ">Ask before sending</button>", ">Show me only</button>",
      'id="runform-when">When</span>',
      ">Now</button>", ">Later ▾</button>",
      ">Run <span",
    ];
    const at = order.map((part) => html.indexOf(part));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).toContain('<div class="eos-runsheet eos-runsheet--centre">');
  });

  it("fills itself from a run's input for Run again", async () => {
    registerHost();
    open({ routineId: PR.id, anchor: null, input: { item: ITEM, options: { depth: "deep" }, note: "Look at the shaders.", result: "showOnly" }, againOf: "rn-1" });
    const html = sheet();
    expect(html).toContain("Rework shop carousel paging");
    expect(html).toContain('value="Look at the shaders."');
    expect(html).toContain('aria-checked="true" class="eos-seg__opt">Deep</button>');
    expect(html).toContain('aria-checked="true" class="eos-seg__opt">Show me only</button>');
  });

  it("closes on Esc and keeps the half-filled form for its routine; an open item list takes Esc first", () => {
    registerHost();
    open({ routineId: PR.id, anchor: null });
    sheet();
    expect(sheetEscape({ key: "Escape", target: { getAttribute: () => "true" } })).toBe(false);
    expect(sheetEscape({ key: "Escape", target: { getAttribute: () => "false" } })).toBe(true);
    expect(press("Escape")).toBe(true);
    expect(current().request).toBeNull();

    keepForm(PR.id, { ...initialForm(PR.options, null, 0), note: "Half written" });
    open({ routineId: PR.id, anchor: null });
    expect(sheet()).toContain('value="Half written"');
    press("Escape");
    open({ routineId: PR.id, anchor: null });
    expect(sheet()).toContain('value="Half written"');
    open({ routineId: PR.id, anchor: null, input: { options: {}, result: "usual" }, againOf: "rn-1" });
    expect(sheet()).not.toContain("Half written");
  });

  it("anchors right of a sidebar row, under Run now, and centred otherwise", () => {
    const rect = { top: 100, bottom: 130, left: 200, right: 280 };
    const button = (cls) => ({ classList: { contains: (c) => c === cls }, getBoundingClientRect: () => rect });
    expect(sheetPlace(button("eos-side-run"))).toEqual({ where: "side", door: "sidebar", rect });
    expect(sheetPlace(button("eos-btn"))).toEqual({ where: "below", door: "routine_page", rect });
    expect(sheetPlace(null)).toEqual({ where: "centre", door: "routine_page" });
    const viewport = { width: 1440, height: 900 };
    expect(sheetStyle({ where: "side", rect }, viewport)).toEqual({ top: 88, left: 288, maxHeight: 796 });
    expect(sheetStyle({ where: "below", rect: { ...rect, right: 300 } }, viewport)).toEqual({ top: 138, left: 16, maxHeight: 746 });
    expect(sheetStyle({ where: "centre" }, viewport)).toBeUndefined();
  });

  it("starts on ⌘↵ with the form's body and opens the started run's view", async () => {
    const transport = recording(async (method, path) => (path === ROUTES.runs
      ? { ok: true, status: 201, body: { runs: [{ id: "rn-new", state: "queued" }] } }
      : { ok: false, status: 404, body: {} }));
    setEosTransport(transport);
    registerHost();
    open({ routineId: PR.id, anchor: null, input: { item: ITEM, options: {}, result: "ask" }, againOf: "rn-1" });
    sheet();
    expect(press("Enter", { metaKey: true })).toBe(true);
    await flush();
    const [, path, body] = transport.send.mock.calls.find((c) => c[1] === ROUTES.runs);
    expect(path).toBe(ROUTES.runs);
    expect(body).toMatchObject({ routineId: PR.id, input: { item: ITEM, options: {}, result: "ask" }, againOf: "rn-1", door: "routine_page" });
    expect(typeof body.clientRequestId).toBe("string");
    expect(eosLocation()).toBe("eos:/runs/rn-new");
    expect(current().request).toBeNull();
  });
});

describe("the run form's keys", () => {
  it("holds plain Enter in a field and lets ⌘↵ and the Run button through", () => {
    const key = (target, extra = {}) => holdsEnter({ key: "Enter", metaKey: false, ctrlKey: false, target, ...extra });
    const input = { tagName: "INPUT" };
    expect(key(input)).toBe(true);
    expect(key(input, { metaKey: true })).toBe(false);
    expect(key(input, { ctrlKey: true })).toBe(false);
    expect(key({ tagName: "BUTTON" })).toBe(false);
    expect(holdsEnter({ key: "a", target: input })).toBe(false);
  });

  it("takes the highlighted candidate on Enter and otherwise does nothing", () => {
    expect(comboKey({ open: true, active: 1 }, "Enter", 3)).toEqual({ open: false, active: -1, chosen: 1 });
    expect(comboKey({ open: true, active: -1 }, "Enter", 3)).toBeNull();
    expect(comboKey({ open: false, active: -1 }, "Enter", 3)).toBeNull();
  });
});

describe("starting a run", () => {
  it("tells a same-item refusal, the day cap, a dev run and other refusals apart", async () => {
    const answer = (r) => { setEosTransport({ get: fixtureTransport({}).get, send: async () => r }); return startRun({}); };
    expect(await answer({ ok: false, status: 409, body: { error: "the routine handled this item lately", existingRunId: "rn-1" } })).toEqual({ repeat: "rn-1" });
    expect(await answer({ ok: false, status: 409, body: { error: "routines spent today's budget", code: "day_cap" } })).toEqual({ dayCap: true });
    expect(await answer({ ok: false, status: 403, body: { error: "refused in a dev run: POST /api/runs" } })).toEqual({ devRun: true });
    expect(await answer({ ok: false, status: 400, body: { error: "invalid request: item: Required" } })).toEqual({ error: "invalid request: item: Required" });
  });
});

describe("the item combobox", () => {
  it("opens with Down, moves with Up and Down, takes the active one with Enter and closes with Escape", () => {
    let s = { open: false, active: -1 };
    s = comboKey(s, "ArrowDown", 3);
    expect(s).toEqual({ open: true, active: 0 });
    s = comboKey(s, "ArrowUp", 3);
    expect(s).toEqual({ open: true, active: 2 });
    expect(comboKey(s, "Enter", 3)).toEqual({ open: false, active: -1, chosen: 2 });
    expect(comboKey(s, "Escape", 3)).toEqual({ open: false, active: -1 });
    expect(comboKey({ open: false, active: -1 }, "Escape", 3)).toBeNull();
    expect(comboKey({ open: false, active: -1 }, "Enter", 3)).toBeNull();
    expect(comboKey({ open: false, active: -1 }, "ArrowDown", 0)).toEqual({ open: false, active: -1 });
  });

  it("adds a chosen item once when the routine takes several, and replaces it when it takes one", () => {
    const form = { ...initialForm([], null, 0), text: "#47" };
    const two = withChosen(withChosen(form, ITEM, true), { ...ITEM }, true);
    expect(two.items).toEqual([ITEM]);
    expect(two.text).toBe("");
    expect(withChosen({ ...form, item: { kind: "x", untrusted: false } }, ITEM, false)).toMatchObject({ item: ITEM, text: "" });
  });
});

describe("Later", () => {
  it("offers Today, Tomorrow or a day, in local time, and says it back", () => {
    const now = new Date(2026, 10, 20, 14, 25).getTime();
    expect(laterAt("tomorrow", "09:00", now)).toBe(new Date(2026, 10, 21, 9, 0).getTime());
    expect(laterAt("today", firstTime("today", now), now)).toBe(new Date(2026, 10, 20, 15, 0).getTime());
    expect(laterAt("2026-11-24", "18:30", now)).toBe(new Date(2026, 10, 24, 18, 30).getTime());
    expect(whenWords(laterAt("tomorrow", "09:00", now), now)).toBe("Tomorrow 09:00");
    expect(whenWords(laterAt("today", "15:00", now), now)).toBe("Today 15:00");
    expect(firstTime("tomorrow", now)).toBe("09:00");
  });
});
