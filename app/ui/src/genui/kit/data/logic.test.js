import { describe, it, expect } from "vitest";
import { applyLens, compareValues, looseNumber, mix, numberItems, seriesColors, toneStyle } from "./util.js";
import { formatNumber, priceLevel, withUnit } from "./format.js";
import { bestCells, bestDirections, cellDisplay, nextSort, sortRows } from "./tableLogic.js";
import { clampStep, stepDots, stepFlags, stepNav } from "./stepsLogic.js";
import { meterMax } from "./Meter.jsx";
import { progressOf } from "./Progress.jsx";
import { valueText } from "./Value.jsx";
import { deltaDirection, deltaMood } from "./Stat.jsx";
import { parseBest, parseCols } from "../../../../../../contracts/src/genui/attrs.ts";
import restaurants from "../../../../../../contracts/src/__tests__/fixtures/genui/restaurants.json";

const places = restaurants.data.places;

describe("looseNumber", () => {
  it("reads numbers out of display strings, distances in meters", () => {
    expect(looseNumber(4.7)).toBe(4.7);
    expect(looseNumber("650 m")).toBe(650);
    expect(looseNumber("1,4 km")).toBe(1400);
    expect(looseNumber("₺42.000")).toBe(42000);
    expect(looseNumber("1,234,567")).toBe(1234567);
    expect(looseNumber("38,4s")).toBe(38.4);
    expect(looseNumber("20%")).toBe(20);
    expect(looseNumber({ until: "23:30" })).toBe(23.3);
    expect(looseNumber("—")).toBe(null);
    expect(looseNumber(true)).toBe(null);
  });

  it("compareValues puts empty values last and compares numbers as numbers", () => {
    expect(["900 m", "1,4 km", "300 m"].sort(compareValues)).toEqual(["300 m", "900 m", "1,4 km"]);
    expect([null, 2, 1].sort(compareValues)).toEqual([1, 2, null]);
    expect(["b", "A", "c"].sort(compareValues)).toEqual(["A", "b", "c"]);
  });
});

describe("applyLens / numberItems", () => {
  it("applies where, skip, sort and limit in that order", () => {
    const out = applyLens(places, { where: "price <= 2", skip: "moda", sort: "-rating", limit: "2" }, {});
    expect(out.map((p) => p.id)).toEqual(["lal", "ocak"]);
  });

  it("where can read state", () => {
    const stops = [{ id: 1, day: "Sat" }, { id: 2, day: "Sun" }];
    expect(applyLens(stops, { where: "day == state.day" }, { day: "Sun" }).map((s) => s.id)).toEqual([2]);
  });

  it("where takes ||, ( ) and state.key on the left", () => {
    const ingredients = [{ id: "sogan" }, { id: "domates" }, { id: "biber" }];
    const where = "id != 'sogan' || state.ekol == 'Soğanlı'";
    expect(applyLens(ingredients, { where }, { ekol: "Soğanlı" }).map((x) => x.id)).toEqual(["sogan", "domates", "biber"]);
    expect(applyLens(ingredients, { where }, { ekol: "Sade" }).map((x) => x.id)).toEqual(["domates", "biber"]);
    expect(applyLens(places, { where: "(price <= 1 || rating >= 4.6) && !(id == yel)" }, {}).map((p) => p.id)).toEqual(["moda", "lal", "ocak", "rihtim"]);
  });

  it("numbers stay stable when shared chips hide items", () => {
    const num = numberItems(places, {}, {});
    const visible = places.filter((p) => p.id !== "moda");
    expect(num(visible[0])).toBe(2);
    expect(num({ id: "ocak" })).toBe(3);
  });
});

describe("tones", () => {
  it("re-points the tone vars and orders series from the view tone", () => {
    expect(toneStyle("teal")["--gv-accent"]).toBe("#26c1c8");
    expect(toneStyle("nope")).toBeUndefined();
    expect(seriesColors("amber", 3)).toEqual(["#dc9d39", "#67affd", "#61c380"]);
    expect(mix("#5cb8c4", "#171717", 0.25)).toBe("#283f42");
  });
});

describe("formatNumber", () => {
  it("formats by kind with the given locale", () => {
    expect(formatNumber(9400, { format: "currency", currency: "TRY", locale: "tr-TR" })).toBe("₺9.400");
    expect(formatNumber(0.2, { format: "percent", locale: "en-US" })).toBe("20%");
    expect(formatNumber(1234567, { format: "compact", locale: "en-US" })).toBe("1.2M");
    expect(formatNumber(9.84, { format: "int", locale: "en-US" })).toBe("10");
    expect(formatNumber(3.14159, { decimals: 2, locale: "en-US" })).toBe("3.14");
    expect(formatNumber(12, { prefix: "₺", suffix: "/mo", locale: "en-US" })).toBe("₺12/mo");
    expect(formatNumber("x")).toBe("");
  });

  it("units and price levels", () => {
    expect(withUnit("9,8", "s")).toBe("9,8s");
    expect(withUnit("1,24", "kg")).toBe("1,24 kg");
    expect(priceLevel(2, "TRY")).toBe("₺₺");
    expect(priceLevel(5, "USD")).toBe("$$$$");
    expect(priceLevel(0, "USD")).toBe("");
  });
});

describe("Table logic", () => {
  const cols = parseCols(restaurants.ui.match(/cols="([^"]+)"/)[1]);

  it("cells show ratings, price levels and closing hours", () => {
    const moda = places[0];
    expect(cellDisplay(moda, "rating")).toEqual({ text: "★ 4.7", kind: "rating" });
    expect(cellDisplay(moda, "price").text).toMatch(/^(.)\1$/u);
    expect(cellDisplay(moda, "hours")).toEqual({ text: "00:00", kind: "mono" });
    expect(cellDisplay({ hours: { closed: true } }, "hours").text).toBe("Closed");
    expect(cellDisplay({}, "distance")).toEqual({ text: "—", kind: "empty" });
    expect(cellDisplay({ tags: ["a", "b"] }, "tags").text).toBe("a, b");
  });

  it("best highlights the winning cell per column", () => {
    const dirs = bestDirections(parseBest("rating:max price:min"), cols);
    expect(dirs).toEqual({ rating: "max", price: "min" });
    const best = bestCells(places, dirs);
    expect([...best.rating].map((i) => places[i].id)).toEqual(["moda"]);
    expect([...best.price].map((i) => places[i].id).sort()).toEqual(places.filter((p) => p.price === 1).map((p) => p.id).sort());
  });

  it("bare best picks the column direction itself and skips ties", () => {
    const dirs = bestDirections("auto", parseCols("name rating price distance"));
    expect(dirs).toEqual({ rating: "max", price: "min", distance: "min" });
    const best = bestCells(places, dirs);
    expect([...best.distance].map((i) => places[i].id)).toEqual([places.reduce((a, b) => (looseNumber(a.distance) <= looseNumber(b.distance) ? a : b)).id]);
    expect(bestCells([{ r: 1 }, { r: 1 }], { r: "max" })).toEqual({});
  });

  it("header sort cycles asc → desc → off and sorts loose numbers", () => {
    let s = nextSort(null, "distance");
    expect(s).toEqual({ field: "distance", desc: false });
    const asc = sortRows(places, s).map((p) => looseNumber(p.distance));
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    s = nextSort(s, "distance");
    expect(s.desc).toBe(true);
    expect(sortRows(places, s)[0].distance).toBe(places.reduce((a, b) => (looseNumber(a.distance) >= looseNumber(b.distance) ? a : b)).distance);
    expect(nextSort(s, "distance")).toBe(null);
    expect(nextSort(s, "rating")).toEqual({ field: "rating", desc: false });
    expect(sortRows(places, null)).toBe(places);
  });
});

describe("Steps navigation", () => {
  it("clamps, steps and flags the ends", () => {
    expect(clampStep(9, 4)).toBe(3);
    expect(clampStep(-2, 4)).toBe(0);
    expect(clampStep("2", 4)).toBe(2);
    expect(clampStep(1, 0)).toBe(0);
    expect(stepNav(0, 4, -1)).toBe(0);
    expect(stepNav(0, 4, 1)).toBe(1);
    expect(stepNav(3, 4, 1)).toBe(3);
    expect(stepFlags(0, 4)).toEqual({ index: 0, atStart: true, atEnd: false, label: "Step 1 / 4" });
    expect(stepFlags(3, 4).atEnd).toBe(true);
    expect(stepDots(1, 3)).toEqual([
      { current: false, done: true },
      { current: true, done: true },
      { current: false, done: false },
    ]);
  });
});

describe("small formatters", () => {
  it("Meter scale", () => {
    expect(meterMax([9.8, 7.1, 2.1], 9.8)).toBe(9.8);
    expect(meterMax([9.8, 7.1], null)).toBe(9.8);
    expect(meterMax([0.4], null)).toBe(1);
    expect(meterMax([4.2], null)).toBe(5);
    expect(meterMax([8.6], null)).toBe(10);
    expect(meterMax([64], null)).toBe(100);
  });

  it("Progress reads fractions, percents and value/max", () => {
    expect(progressOf(0.25, null).fraction).toBe(0.25);
    expect(progressOf(40, null).fraction).toBe(0.4);
    expect(progressOf(3, 4)).toEqual({ fraction: 0.75, text: "3 / 4" });
    expect(progressOf(null, 4).text).toBe("—");
    expect(progressOf(9, 4).fraction).toBe(1);
  });

  it("Value text", () => {
    expect(valueText(9400, { format: "currency", currency: "TRY", locale: "tr-TR" })).toBe("₺9.400");
    expect(valueText("12", { locale: "en-US" })).toBe("12");
    expect(valueText("soon", { prefix: "→ " })).toBe("→ soon");
    expect(valueText(null)).toBe("—");
    expect(valueText(true)).toBe("true");
  });

  it("Stat delta direction", () => {
    expect(deltaDirection("+4,1s vs main")).toBe("up");
    expect(deltaDirection("−6%")).toBe("down");
    expect(deltaDirection("-6%")).toBe("down");
    expect(deltaDirection("same", undefined)).toBe("flat");
    expect(deltaDirection("+1", "down")).toBe("down");
    // Coloured only when good= says which way is good news.
    expect(deltaMood("up", undefined)).toBe("neutral");
    expect(deltaMood("up", "down")).toBe("bad");
    expect(deltaMood("up", "up")).toBe("good");
    expect(deltaMood("flat", "up")).toBe("neutral");
  });
});
