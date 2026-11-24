import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The probe's measuring script ships inside the core
// (crates/eos-surface/assets) and runs in the shell's hidden view. Here it
// measures a small laid-out page of its own: each element says its style
// and its box, as a browser would compute them.
const PROBE = readFileSync(
  fileURLToPath(new URL("../../../../crates/eos-surface/assets/page-probe.js", import.meta.url)),
  "utf8",
);

function load() {
  const root = {};
  new Function("globalThis", PROBE)(root);
  return root.__eosProbe;
}

function el(tag, { text = "", style = {}, box = {}, part, children = [] } = {}) {
  const node = {
    nodeType: 1,
    tagName: tag,
    style: { display: "block", visibility: "visible", fontSize: "16px", fontWeight: "400",
             color: "rgb(20, 20, 20)", backgroundColor: "rgba(0, 0, 0, 0)", overflowX: "visible", ...style },
    box: { right: 300, height: 20, ...box },
    childNodes: [],
    parentNode: null,
    getAttribute: (name) => (name === "data-part" ? part || null : null),
    getBoundingClientRect: () => node.box,
    getElementsByTagName: (name) => descendants(node).filter((d) => name === "*" || d.tagName === name),
    get textContent() {
      return node.childNodes.map((c) => (c.nodeType === 3 ? c.nodeValue : c.textContent)).join("");
    },
  };
  if (text) node.childNodes.push({ nodeType: 3, nodeValue: text });
  for (const child of children) {
    child.parentNode = node;
    node.childNodes.push(child);
  }
  return node;
}

function descendants(node) {
  return node.childNodes.filter((c) => c.nodeType === 1).flatMap((c) => [c, ...descendants(c)]);
}

function page(body, { width = 360, scrollWidth = 360 } = {}) {
  const doc = {
    body,
    documentElement: { scrollWidth },
    querySelectorAll: () => descendants(body).filter((d) => d.getAttribute("data-part")),
  };
  const win = { innerWidth: width, getComputedStyle: (node) => node.style };
  return [doc, win];
}

describe("the page probe's measuring script", () => {
  it("finds nothing in a page a person reads easily", () => {
    const body = el("body", { style: { backgroundColor: "rgb(255, 255, 255)" },
      children: [el("section", { part: "lead", children: [el("h2", { text: "Replays ship" })] })] });
    expect(load().measure(...page(body)).findings).toEqual([]);
  });

  it("finds small text, faint text and a long run under 14 px", () => {
    const long = "word ".repeat(20);
    const body = el("body", { children: [el("section", { part: "lead", children: [
      el("p", { text: "tiny", style: { fontSize: "11px" } }),
      el("p", { text: "faint", style: { color: "rgb(200, 200, 200)" } }),
      el("p", { text: long, style: { fontSize: "13px" } }),
    ] })] });
    const found = load().measure(...page(body)).findings;
    expect(found).toEqual([
      { check: "readable", part: "lead", detail: "text at 11 px, at least 12 px" },
      { check: "readable", part: "lead", detail: "contrast 1.67:1, at least 4.5:1" },
      { check: "readable", part: "lead", detail: "text at 13 px, at least 14 px" },
    ]);
  });

  it("finds a page wider than the window and a box past its edge, but not inside a scrolling table", () => {
    const body = el("body", { children: [
      el("section", { part: "wide", box: { right: 420 }, text: "too wide" }),
      el("div", { part: "table", style: { overflowX: "auto" }, text: "rows",
        children: [el("table", { box: { right: 900 }, text: "cells" })] }),
    ] });
    const found = load().measure(...page(body, { scrollWidth: 420 })).findings;
    expect(found.map((f) => [f.check, f.part])).toEqual([["narrow", null], ["narrow", "wide"]]);
  });

  it("finds a part that shows nothing", () => {
    const body = el("body", { children: [el("section", { part: "rail", box: { height: 0 } })] });
    expect(load().measure(...page(body)).findings).toEqual([{ check: "empty", part: "rail", detail: "shows nothing" }]);
  });

  it("weighs large and bold text against 3:1", () => {
    const { contrast, channels } = load();
    const grey = channels("rgb(150, 150, 150)");
    const white = channels("rgb(255, 255, 255)");
    expect(contrast(grey, white)).toBeGreaterThan(2.9);
    expect(contrast(grey, white)).toBeLessThan(3.1);
  });
});
