import { describe, it, expect } from "vitest";
import {
  billsByRun, chipLabel, estimateBody, estimateLine, formProblem, initialForm, optionsOf, repeatLine, splitOptions,
  startBody, timeWords, usualEstimate,
} from "./runFormModel.js";
import routines from "../gallery/sample/routines.json";

const NOW = 1763460000000;
const HOUR = 3_600_000;
const PR = routines[0];
const opt = (key, inline, extra = {}) => ({ key, label: key, type: "choice", values: ["quick", "deep"], default: "quick", inline, ...extra });
const PR_PATTERNS = { ...PR, takes: { ...PR.takes, itemPatterns: ["https://github\\.com/([\\w.-]+)/([\\w.-]+)/pull/(\\d+)", "(?:^|\\s)#(\\d+)\\b"] } };
const ONE_AT_A_TIME = { ...PR, takes: { ...PR.takes, many: false, empty: "required" } };
const ITEM = { kind: "github.pull_request", key: "github:pr:acme/game#470@ab12", title: "Rework shop carousel paging", untrusted: true };

describe("the run form's model", () => {
  it("opens with the blueprint's defaults, or with an earlier run's input for Run again", () => {
    const options = optionsOf(PR, null);
    expect(options).toBe(PR.options);
    expect(initialForm(options, null, NOW)).toEqual({ item: null, items: [], text: "", options: { depth: "quick" }, note: "", result: "usual", at: null });
    const again = { item: ITEM, options: { depth: "deep", gone: 1 }, note: "Look at the shaders.", result: "showOnly", at: NOW - 1 };
    expect(initialForm(options, again, NOW)).toEqual({
      item: ITEM, items: [], text: "", options: { depth: "deep" }, note: "Look at the shaders.", result: "showOnly", at: null,
    });
    expect(initialForm(options, { ...again, at: NOW + HOUR }, NOW).at).toBe(NOW + HOUR);
    expect(initialForm(options, again, NOW, true)).toMatchObject({ item: null, items: [ITEM] });
    const blueprint = { options: [opt("depth", true), opt("tone", false)] };
    expect(optionsOf(PR, blueprint)).toBe(blueprint.options);
  });

  it("puts at most three options inline, those marked inline first, and the rest behind More", () => {
    const options = [opt("a", false), opt("b", true), opt("c", true), opt("d", true), opt("e", true)];
    const { inline, more } = splitOptions(options);
    expect(inline.map((o) => o.key)).toEqual(["b", "c", "d"]);
    expect(more.map((o) => o.key)).toEqual(["a", "e"]);
  });

  it("checks the item against what the routine takes and its item patterns", () => {
    const form = initialForm(PR.options, null, NOW);
    expect(formProblem(form, PR_PATTERNS, NOW)).toBeNull();
    expect(formProblem({ ...form, text: "#470" }, PR_PATTERNS, NOW)).toBeNull();
    expect(formProblem({ ...form, text: "https://github.com/acme/game/pull/12" }, PR_PATTERNS, NOW)).toBeNull();
    expect(formProblem({ ...form, text: "the login fix" }, PR_PATTERNS, NOW)).toBe("PR Review takes a pull request.");
    expect(formProblem(form, ONE_AT_A_TIME, NOW)).toBe("Choose a pull request.");
    expect(formProblem({ ...form, item: ITEM, text: "#2" }, ONE_AT_A_TIME, NOW)).toBe("PR Review takes one pull request at a time.");
    const many = Array.from({ length: 21 }, (_, i) => ({ ...ITEM, key: `k${i}` }));
    expect(formProblem({ ...form, items: many }, PR, NOW)).toBe("At most 20 at once.");
    expect(formProblem({ ...form, at: NOW - 1 }, PR, NOW)).toBe("Pick a time later than now.");
  });

  it("says the estimate with dollars on an API key and time only on a Claude plan", () => {
    const form = { ...initialForm(PR.options, null, NOW), options: { depth: "deep" } };
    const inline = PR.options;
    const one = { usd: 0.55, ms: 300_000, basis: "history", n: 1 };
    expect(estimateLine(one, { form, inline, plan: false })).toBe("A deep run usually takes about five minutes and $0.55.");
    expect(estimateLine(one, { form, inline, plan: true })).toBe("A deep run usually takes about five minutes.");
    expect(estimateLine({ ...one, usd: 1.65, n: 3 }, { form, inline, plan: false })).toBe("Three runs usually take about five minutes each and $1.65 in all.");
    expect(estimateLine(one, { form, inline: [], plan: true })).toBe("A run usually takes about five minutes.");
    expect(estimateLine(null, { form, inline, plan: true })).toBeNull();
    expect([timeWords(20_000), timeWords(60_000), timeWords(3_700_000), timeWords(7_200_000)]).toEqual(["under a minute", "one minute", "an hour", "two hours"]);
  });

  it("knows a key from a plan by the Claude account's route", () => {
    expect(billsByRun([{ id: "anthropic", route: "api_key" }])).toBe(true);
    expect(billsByRun([{ id: "anthropic", route: "subscription" }])).toBe(false);
    expect(billsByRun(null)).toBe(false);
  });

  it("takes the routine's usual cost only while the options are their defaults, and asks the core per option", () => {
    const routine = { ...PR, usual: { usd: 0.4, ms: 240_000 } };
    const form = initialForm(PR.options, null, NOW);
    expect(usualEstimate(routine, PR.options, form, 2)).toEqual({ usd: 0.8, ms: 240_000, n: 2 });
    expect(usualEstimate(routine, PR.options, { ...form, options: { depth: "deep" } }, 1)).toBeNull();
    expect(estimateBody(routine, PR.options, { ...form, options: { depth: "deep" }, items: [ITEM, ITEM] })).toEqual({
      routineId: PR.id, input: { item: ITEM, options: { depth: "deep" }, result: "usual" }, count: 2,
    });
  });

  it("builds the start body: one item in the input, several as items, the changed options, the note, the time", () => {
    const form = { ...initialForm(PR.options, null, NOW), item: ITEM, options: { depth: "quick" }, note: "  Look at the shaders. ", result: "ask", at: NOW + HOUR };
    expect(startBody(ONE_AT_A_TIME, PR.options, form, { door: "sidebar", clientRequestId: "c-1" })).toEqual({
      routineId: PR.id,
      input: { item: ITEM, options: {}, note: "Look at the shaders.", result: "ask", at: NOW + HOUR },
      door: "sidebar",
      clientRequestId: "c-1",
    });
    const two = { ...form, items: [ITEM], text: "#471", note: "", at: null, options: { depth: "deep" } };
    const typed = { kind: "github.pull_request", text: "#471", title: "#471", untrusted: false };
    const body = startBody(PR, PR.options, two, { door: "routine_page", clientRequestId: "c-2", confirmRepeat: true, againOf: "rn-1" });
    expect(body).toEqual({
      routineId: PR.id,
      input: { options: { depth: "deep" }, result: "ask" },
      items: [ITEM, typed],
      againOf: "rn-1",
      door: "routine_page",
      confirmRepeat: true,
      clientRequestId: "c-2",
    });
    expect(Object.keys(body)).toEqual(["routineId", "input", "items", "againOf", "door", "confirmRepeat", "clientRequestId"]);
  });

  it("says what a same-item refusal found: the run at work now, or when it ran and at which version", () => {
    const earlier = { run: { state: "done", createdAt: NOW - 2 * HOUR - 60_000 }, input: { item: { ...ITEM, version: "ab12" } } };
    expect(repeatLine(PR, earlier, NOW)).toBe("PR Review ran on this two hours ago at the same commit.");
    expect(repeatLine(PR, { ...earlier, input: { item: ITEM } }, NOW)).toBe("PR Review ran on this two hours ago.");
    expect(repeatLine(PR, { ...earlier, run: { state: "running", createdAt: NOW } }, NOW)).toBe("PR Review is working on this now.");
  });

  it("names an item on a chip by its number", () => {
    expect(chipLabel(ITEM)).toBe("#470");
    expect(chipLabel({ url: "https://github.com/acme/game/pull/12" })).toBe("#12");
    expect(chipLabel({ title: "A very long title for one item here" })).toBe("A very long title for o…");
  });
});
