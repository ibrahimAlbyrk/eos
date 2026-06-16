import { describe, it, expect } from "vitest";
import { createKeymap, combo, isMod } from "./keymap.js";

const ev = (o) => ({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "", code: "", ...o });

describe("combo", () => {
  it("plain mod+letter matches Cmd+G (case-insensitive) and rejects extra modifiers", () => {
    const m = combo("mod+g");
    expect(m(ev({ metaKey: true, key: "g" }))).toBe(true);
    expect(m(ev({ metaKey: true, key: "G" }))).toBe(true);
    expect(m(ev({ metaKey: true, ctrlKey: true, key: "g" }))).toBe(false); // ctrl down → no
    expect(m(ev({ metaKey: true, shiftKey: true, key: "g" }))).toBe(false);
    expect(m(ev({ key: "g" }))).toBe(false); // no Cmd
    expect(m(ev({ metaKey: true, key: "h" }))).toBe(false);
  });

  it("mod+ctrl+t with code matches e.code KeyT and requires ctrl", () => {
    const m = combo("mod+ctrl+t", { code: true });
    expect(m(ev({ metaKey: true, ctrlKey: true, code: "KeyT" }))).toBe(true);
    expect(m(ev({ metaKey: true, code: "KeyT" }))).toBe(false); // needs ctrl
    expect(m(ev({ metaKey: true, ctrlKey: true, shiftKey: true, code: "KeyT" }))).toBe(false);
  });

  it("plain mod+t (key) stays disjoint from mod+ctrl+t (chord)", () => {
    const plain = combo("mod+t");
    const chord = combo("mod+ctrl+t", { code: true });
    const cmdT = ev({ metaKey: true, key: "t", code: "KeyT" });
    const cmdCtrlT = ev({ metaKey: true, ctrlKey: true, key: "t", code: "KeyT" });
    expect(plain(cmdT)).toBe(true);
    expect(plain(cmdCtrlT)).toBe(false);
    expect(chord(cmdCtrlT)).toBe(true);
    expect(chord(cmdT)).toBe(false);
  });
});

describe("isMod", () => {
  it("is true only for plain Cmd", () => {
    expect(isMod(ev({ metaKey: true }))).toBe(true);
    expect(isMod(ev({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isMod(ev({ ctrlKey: true }))).toBe(false);
    expect(isMod(ev({}))).toBe(false);
  });
});

describe("createKeymap", () => {
  it("registers, resolves a match, and unregisters", () => {
    const km = createKeymap();
    let ran = 0;
    const off = km.register({ match: combo("mod+g"), run: () => { ran++; } });
    expect(km.handle(ev({ metaKey: true, key: "g" }), {})).toBe(true);
    expect(ran).toBe(1);
    expect(km.handle(ev({ metaKey: true, key: "x" }), {})).toBe(false);
    off();
    expect(km.handle(ev({ metaKey: true, key: "g" }), {})).toBe(false);
  });

  it("when() gates a binding on context", () => {
    const km = createKeymap();
    let ran = 0;
    km.register({ match: combo("mod+g"), when: (ctx) => ctx.enabled, run: () => { ran++; } });
    expect(km.handle(ev({ metaKey: true, key: "g" }), { enabled: false })).toBe(false);
    expect(km.handle(ev({ metaKey: true, key: "g" }), { enabled: true })).toBe(true);
    expect(ran).toBe(1);
  });

  it("higher priority wins; ties go to the most recently registered", () => {
    const km = createKeymap();
    const order = [];
    km.register({ match: combo("mod+g"), priority: 0, run: () => order.push("low") });
    km.register({ match: combo("mod+g"), priority: 10, run: () => order.push("high") });
    km.register({ match: combo("mod+g"), priority: 10, run: () => order.push("high2") });
    km.handle(ev({ metaKey: true, key: "g" }), {});
    expect(order).toEqual(["high2"]);
  });

  it("run receives (ctx, event)", () => {
    const km = createKeymap();
    let seen = null;
    km.register({ match: combo("mod+g"), run: (ctx, e) => { seen = { ctx, key: e.key }; } });
    km.handle(ev({ metaKey: true, key: "g" }), { who: "me" });
    expect(seen).toEqual({ ctx: { who: "me" }, key: "g" });
  });
});
