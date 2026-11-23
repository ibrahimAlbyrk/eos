import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ROUTES } from "../../../api/routes.js";
import { _resetHome, refreshHome, RUNS_PATH } from "../../../state/eos/homeStore.js";
import { _resetHomeDraft, setHomeDraft, setHomePick } from "../../../state/eos/homeDraftStore.js";
import { _resetInbox, refreshInbox } from "../../../state/eos/inboxStore.js";
import { _resetNotes, refreshMemorySummary } from "../../../state/eos/notesStore.js";
import { _resetRoutines, offeredRoutines, refreshRoutines } from "../../../state/eos/routinesStore.js";
import { fixtureTransport, setEosTransport } from "../../../state/eos/transport.js";
import { SAMPLE_READS } from "../gallery/EosGallery.jsx";
import { homeNext, homeRuns } from "../gallery/sample/home.js";
import routines from "../gallery/sample/routines.json";
import { HomeScreen } from "../home/HomeScreen.jsx";
import { discStatus, discsMatching } from "./discWords.js";
import { DROP_START, dropForm, droppedItem } from "./dropOnDisc.js";
import { optionsOf, startBody } from "../runform/runFormModel.js";
import { _resetField, armField, closeField, FIELD_VIEW_KEY, openField, setFieldView, shownView, useField } from "./fieldStore.js";
import { discDelays, dotDelay, ENTER_MS, LEAVE_MS, nextPhase } from "./transition.js";
import { FieldLayer } from "./FieldLayer.jsx";
import { discOf } from "./placeDiscs.js";

vi.mock("../../../keymap/useKeymap.js", () => ({ useGlobalKeymap: () => {}, useKeybinding: () => {} }));

const NOW = new Date(2026, 10, 17, 9, 12).getTime();
const PR = { ...routines[0], takes: { ...routines[0].takes, itemPatterns: ["https://github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d+)"] } };

function stubStorage() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: (k) => data.delete(k), data };
}

const field = (rows, props = {}) => renderToStaticMarkup(<FieldLayer routines={rows} needs={{}} next={{}} now={NOW} {...props} />);
const many = (n) => Array.from({ length: n }, (_, i) => ({ ...routines[i % routines.length], id: `rt-${i}`, name: `Routine ${i}`, activeRuns: i % 3 === 0 ? 1 : 0 }));

beforeEach(() => {
  globalThis.localStorage = stubStorage();
  _resetField();
  _resetHomeDraft();
  _resetHome();
  _resetInbox();
  _resetRoutines();
  _resetNotes();
});
afterEach(() => setEosTransport(null));

describe("the field", () => {
  it("is drawn only while the input has focus", () => {
    expect(field(routines)).toBe("");
    openField();
    const html = field(routines, { caption: "Good morning. Two need you.", handled: "Eos handled 31 things overnight." });
    expect(html).toContain('aria-label="Your routines around the input"');
    expect(html).toContain("Good morning. Two need you.");
    expect(html).toContain("Eos handled 31 things overnight.");
    expect(html).toContain("Back to home");
    expect(html.match(/class="eos-disc /g)).toHaveLength(routines.length);
    expect(html).toContain('aria-label="Open PR Review"');
    expect(html).toContain("Quiet");
  });

  it("places the routine that needs the user on the inner ring, and only one disc is in the tab order", () => {
    openField();
    const html = field(routines, { needs: { [routines[0].id]: 2 } });
    expect(html).toContain("eos-disc eos-disc--t1");
    expect(html).toContain("Two waiting for you");
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });

  it("dims the discs the text is not about, and marks the one picked", () => {
    openField();
    setHomeDraft("mail triage, the boss only");
    let html = field(routines);
    expect(html.match(/--dim:0.3/g)?.length).toBe(routines.length - 1);
    setHomeDraft("");
    setHomePick(routines[2].id);
    html = field(routines);
    expect(html).toContain('aria-pressed="true" aria-label="Mail Triage. Picked"');
  });

  it("many: opens as the List when a ring overflows, and keeps the viewer's choice", () => {
    openField();
    expect(field(many(40))).toContain('class="eos-rlist"');
    setFieldView("field");
    expect(globalThis.localStorage.data.get(FIELD_VIEW_KEY)).toBe("field");
    expect(field(many(40))).toMatch(/eos-disc--plus/);
    expect(shownView("auto", true)).toBe("field");
    expect(shownView("auto", false)).toBe("list");
  });

  it("empty and first run: no disc, the first-run caption, still a way back", () => {
    openField();
    const html = field([], { caption: "Good morning." });
    expect(html).not.toContain("eos-disc ");
    expect(html).toContain("Your routines will gather here.");
    expect(html).toContain("Back to home");
  });

  it("loading: the rings and the caption, no disc yet and no first-run words", () => {
    openField();
    const html = field([], { caption: "Good morning.", status: "loading" });
    expect(html).toContain("eos-field__ring--3");
    expect(html).toContain("Good morning.");
    expect(html).not.toContain("gather here");
    expect(html).not.toContain("eos-disc ");
  });

  it("error: the routines could not be read, with Try again", () => {
    openField();
    const html = field([], { caption: "Good morning.", status: "failed" });
    expect(html).toContain("Couldn&#x27;t load routines. <button");
    expect(html).not.toContain("gather here");
  });

  it("offline: the discs stay, and the header says it is reconnecting", () => {
    openField();
    const html = field(routines, { handled: "Eos handled 31 things overnight.", status: "offline" });
    expect(html.match(/class="eos-disc /g)).toHaveLength(routines.length);
    expect(html).toContain('role="status">Reconnecting…</span>');
    expect(html).not.toContain("handled 31");
  });

  it("turns Home into the field: the rest of Home is inert and the input moves to the centre", async () => {
    setEosTransport(fixtureTransport({ ...SAMPLE_READS, [RUNS_PATH]: { runs: homeRuns(NOW) }, [ROUTES.signalsRoutines]: homeNext(NOW) }));
    await Promise.all([refreshHome(), refreshInbox(), refreshRoutines(), refreshMemorySummary()]);
    expect(renderToStaticMarkup(<HomeScreen clock={() => NOW} />)).not.toContain("is-field");
    openField();
    armField();
    const html = renderToStaticMarkup(<HomeScreen clock={() => NOW} />);
    expect(html).toContain("eos-screen eos-home is-field");
    expect(html).toContain("eos-field is-on is-moving");
    expect(html.match(/inert=""/g)).toHaveLength(2);
  });
});

describe("the routines on the field", () => {
  it("leave out one-offs, archived routines and those in Recently deleted, as the core's intent does", async () => {
    const gone = ["transient", "archived", "deleted"].map((state, i) => ({ ...routines[0], id: `rt-gone-${i}`, name: `Gone ${i}`, state }));
    const draft = { ...routines[1], id: "rt-draft", name: "Being made", state: "draft" };
    const live = routines.filter((r) => r.state !== "archived");
    expect(live.length).toBe(routines.length - 1);
    expect(offeredRoutines([...routines, ...gone, draft]).map((r) => r.id)).toEqual([...live.map((r) => r.id), "rt-draft"]);
    setEosTransport(fixtureTransport({ ...SAMPLE_READS, [ROUTES.routines]: [...routines, ...gone], [RUNS_PATH]: { runs: homeRuns(NOW) }, [ROUTES.signalsRoutines]: homeNext(NOW) }));
    await Promise.all([refreshHome(), refreshInbox(), refreshRoutines(), refreshMemorySummary()]);
    openField();
    const html = renderToStaticMarkup(<HomeScreen clock={() => NOW} />);
    expect(html.match(/class="eos-disc /g)).toHaveLength(live.length);
    expect(html).not.toContain("Gone ");
  });
});

describe("a disc's words", () => {
  it("say what waits, what works, and when it runs next", () => {
    const row = routines[0];
    expect(discStatus(discOf(row, { needs: 1, now: NOW }), row, NOW)).toBe("One waiting for you");
    expect(discStatus(discOf({ ...row, activeRuns: 1 }, { now: NOW }), row, NOW)).toBe("At work");
    const quiet = { ...row, lastRun: { ...row.lastRun, endedAt: NOW - 2.5 * 24 * 3600 * 1000 } };
    expect(discStatus(discOf(quiet, { now: NOW }), quiet, NOW)).toBe("Quiet for two days");
    const friday = new Date(2026, 10, 20, 9, 0).getTime();
    expect(discStatus(discOf(quiet, { nextAt: friday, now: NOW }), quiet, NOW)).toBe("Next on Friday");
  });

  it("are about the routines the text names or holds an item of", () => {
    expect([...discsMatching([PR, routines[2]], "look at https://github.com/a/b/pull/3")]).toEqual([PR.id]);
    expect(discsMatching(routines, "/pr").size).toBe(0);
  });
});

describe("a drop on a disc", () => {
  it("starts with the dropped item when the routine takes it, and refuses it in words otherwise", () => {
    expect(droppedItem(PR, "/Users/a/notes.pdf")).toEqual({ refused: "PR Review takes a pull request." });
    const { item } = droppedItem(PR, "https://github.com/acme/game/pull/482");
    expect(item).toMatchObject({ kind: "github.pull_request", url: "https://github.com/acme/game/pull/482", untrusted: true });
    expect(dropForm(PR, item).items).toEqual([item]);
    const files = { ...PR, name: "Invoice Filer", takes: { kind: "file", label: "invoice", many: false, itemPatterns: [] } };
    expect(droppedItem(files, "/Users/a/acme.pdf").item).toMatchObject({ path: "/Users/a/acme.pdf", title: "acme.pdf", untrusted: true });
    expect(droppedItem({ ...PR, takes: { kind: "none" } }, "x")).toEqual({ refused: "PR Review takes nothing to work on." });
  });

  it("starts from a door the core takes, the field's", () => {
    const runs = readFileSync(new URL("../../../../../../crates/eos-mod-routines/src/routes/runs.rs", import.meta.url), "utf8");
    const doors = [...runs.match(/const DOORS: \[&str; \d+\] = \[([^\]]*)\]/)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const { item } = droppedItem(PR, "https://github.com/acme/game/pull/482");
    const body = startBody(PR, optionsOf(PR), dropForm(PR, item), { ...DROP_START, clientRequestId: "c-1" });
    expect(doors).toContain(body.door);
    expect(body.door).toBe("field");
    expect(body.input.item.untrusted).toBe(true);
  });
});

describe("the transition", () => {
  it("goes home, entering, field, leaving, home, and turns round from either move", () => {
    expect(nextPhase("home", "open")).toBe("entering");
    expect(nextPhase("entering", "ended")).toBe("field");
    expect(nextPhase("field", "leave")).toBe("leaving");
    expect(nextPhase("leaving", "ended")).toBe("home");
    expect(nextPhase("entering", "leave")).toBe("leaving");
    expect(nextPhase("leaving", "open")).toBe("entering");
    expect(nextPhase("home", "leave")).toBe("home");
    expect(nextPhase("field", "open")).toBe("field");
  });

  it("heads for the field one frame after it is drawn, and back at once when turned round", () => {
    vi.useFakeTimers();
    let field;
    const Probe = () => { field = useField(); return null; };
    const look = () => { renderToStaticMarkup(<Probe />); return field; };
    openField();
    expect(look()).toMatchObject({ phase: "entering", on: false, open: true });
    vi.advanceTimersByTime(0);
    expect(look().on).toBe(true);
    closeField();
    expect(look()).toMatchObject({ phase: "leaving", on: false, open: true });
    openField();
    expect(look()).toMatchObject({ phase: "entering", on: true });
    vi.advanceTimersByTime(ENTER_MS);
    expect(look().phase).toBe("field");
    closeField();
    vi.advanceTimersByTime(LEAVE_MS);
    expect(look()).toMatchObject({ phase: "home", open: false });
    vi.useRealTimers();
  });

  it("spreads the discs over 340 ms after 560 ms, and ring by ring past twelve", () => {
    expect(discDelays([{ ring: 1 }])).toEqual([560]);
    expect(discDelays([1, 1, 2, 2, 3, 3].map((ring) => ({ ring })))).toEqual([560, 628, 696, 764, 832, 900]);
    const many = [...Array(4).fill(1), ...Array(4).fill(2), ...Array(6).fill(3)].map((ring) => ({ ring }));
    const delays = discDelays(many);
    expect([delays[0], delays[3], delays[4], delays[8], delays[13]]).toEqual([560, 605, 700, 840, 915]);
    expect([dotDelay(0, 3), dotDelay(2, 3), dotDelay(0, 1)]).toEqual([420, 220, 220]);
  });
});
