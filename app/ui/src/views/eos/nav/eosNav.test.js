import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseLocation, buildLocation, eosLocation, openLocation, goBack, goForward, openEosRoute, _resetEosNav,
} from "./eosNav.js";

const RT = "rt-4k2n8q1x7m3p";

// Every location of the dashboard spec (08 §4.3), as written and as parsed.
const LOCATIONS = [
  ["eos:/", { screen: "home" }],
  ["eos:/needs", { screen: "needs" }],
  ["eos:/needs/nd-0a1b2c3d4e5f", { screen: "need", itemId: "nd-0a1b2c3d4e5f" }],
  ["eos:/routines", { screen: "routines" }],
  ["eos:/routines/new", { screen: "new-routine" }],
  [`eos:/routines/${RT}`, { screen: "routine", routineId: RT }],
  [`eos:/routines/${RT}?tab=overview`, { screen: "routine", routineId: RT, tab: "overview" }],
  [`eos:/routines/${RT}?tab=runs`, { screen: "routine", routineId: RT, tab: "runs" }],
  [`eos:/routines/${RT}?tab=blueprint`, { screen: "routine", routineId: RT, tab: "blueprint" }],
  [`eos:/routines/${RT}?tab=learned`, { screen: "routine", routineId: RT, tab: "learned" }],
  [`eos:/routines/${RT}/versions/7`, { screen: "version", routineId: RT, version: 7 }],
  ["eos:/runs/rn-9c1v5b0z2w8e", { screen: "run", runId: "rn-9c1v5b0z2w8e" }],
  ["eos:/memory", { screen: "memory" }],
  ["eos:/memory?tab=about", { screen: "memory", tab: "about" }],
  ["eos:/memory?tab=work&note=nt-12", { screen: "memory", tab: "work", note: "nt-12" }],
  ["eos:/capabilities", { screen: "capabilities" }],
  ["eos:/capabilities/github", { screen: "capability", capabilityId: "github" }],
  ["eos:/capabilities/my%20tool", { screen: "capability", capabilityId: "my tool" }],
  ["eos:/surfaces/sf-3", { screen: "surface", surfaceId: "sf-3" }],
  ["eos:/surfaces/sf-3?issue=38&mode=reshape", { screen: "surface", surfaceId: "sf-3", issue: 38, mode: "reshape" }],
  ["eos:/form?routine=pr-review", { screen: "form", routine: "pr-review", options: {} }],
  [
    "eos:/form?routine=pr-review&item=%23470&note=Check+the+tests&opt.depth=deep&opt.long=true&showOnly=1&at=2026-11-19T09%3A00&from=link",
    {
      screen: "form", routine: "pr-review", item: "#470", note: "Check the tests", options: { depth: "deep", long: "true" },
      showOnly: true, at: "2026-11-19T09:00", from: "link",
    },
  ],
];

const NOT_LOCATIONS = [
  null, 42, "", "eos:", "eos://needs", "https://example.com", "eos:/nowhere", "eos:/needs/", "eos:/needs/a/b",
  "eos:/routines/new/x", `eos:/routines/${RT}?tab=settings`, `eos:/routines/${RT}/versions/0`,
  `eos:/routines/${RT}/versions/two`, `eos:/routines/${RT}/runs`, "eos:/runs", "eos:/memory/x", "eos:/memory?tab=other",
  "eos:/capabilities/a/b", "eos:/surfaces", "eos:/surfaces/s?issue=0", "eos:/surfaces/s?mode=edit", "eos:/form",
  "eos:/form?item=4", "eos:/form?routine=x&showOnly=yes", "eos:/form/x?routine=y", "eos:/needs/%E0%A4%A",
];

function stubStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
}

beforeEach(() => {
  _resetEosNav();
  globalThis.localStorage = stubStorage();
});
afterEach(() => {
  delete globalThis.localStorage;
});

describe("Eos locations", () => {
  it.each(LOCATIONS)("%s parses and builds back", (text, parsed) => {
    expect(parseLocation(text)).toEqual(parsed);
    expect(buildLocation(parsed)).toBe(text);
  });

  it.each(NOT_LOCATIONS)("%s is no Eos location", (text) => {
    expect(parseLocation(text)).toBeNull();
  });

  it("drops query parts a screen does not take, and empty values", () => {
    expect(parseLocation("eos:/needs?x=1")).toEqual({ screen: "needs" });
    expect(parseLocation("eos:/memory?note=")).toEqual({ screen: "memory" });
  });
});

describe("Eos history", () => {
  it("goes back and forward, and a new place drops what lay ahead", () => {
    openLocation("eos:/needs");
    openLocation("eos:/routines");
    goBack();
    expect(eosLocation()).toBe("eos:/needs");
    goBack();
    expect(eosLocation()).toBe("eos:/");
    goBack();
    expect(eosLocation()).toBe("eos:/");
    goForward();
    expect(eosLocation()).toBe("eos:/needs");
    openLocation("eos:/memory");
    goForward();
    expect(eosLocation()).toBe("eos:/memory");
    goBack();
    expect(eosLocation()).toBe("eos:/needs");
  });

  it("keeps fifty places to go back to", () => {
    for (let i = 1; i <= 60; i++) openLocation(`eos:/runs/rn-${i}`);
    for (let i = 0; i < 60; i++) goBack();
    expect(eosLocation()).toBe("eos:/runs/rn-10");
    for (let i = 0; i < 60; i++) goForward();
    expect(eosLocation()).toBe("eos:/runs/rn-60");
  });

  it("does not stack the place it is already at", () => {
    openLocation("eos:/needs");
    openLocation("eos:/needs");
    goBack();
    expect(eosLocation()).toBe("eos:/");
  });
});

describe("Eos's remembered place", () => {
  it("is where Eos opens, and follows every move", () => {
    globalThis.localStorage = stubStorage({ "eos:location": "eos:/capabilities/github" });
    expect(eosLocation()).toBe("eos:/capabilities/github");
    openLocation("eos:/memory?tab=about");
    expect(localStorage.getItem("eos:location")).toBe("eos:/memory?tab=about");
    goBack();
    expect(localStorage.getItem("eos:location")).toBe("eos:/capabilities/github");
  });

  it("is Home when nothing usable is stored or storage is out of reach", () => {
    globalThis.localStorage = stubStorage({ "eos:location": "eos:/nowhere" });
    expect(eosLocation()).toBe("eos:/");
    _resetEosNav();
    globalThis.localStorage = stubStorage();
    expect(eosLocation()).toBe("eos:/");
    _resetEosNav();
    globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(eosLocation()).toBe("eos:/");
    openLocation("eos:/needs");
    expect(eosLocation()).toBe("eos:/needs");
  });
});

describe("an eos: route from outside the window", () => {
  it("switches to Eos at that location", () => {
    const setActiveView = vi.fn();
    openEosRoute("eos:/capabilities", setActiveView);
    expect(setActiveView).toHaveBeenCalledWith("eos");
    expect(eosLocation()).toBe("eos:/capabilities");
  });
});
