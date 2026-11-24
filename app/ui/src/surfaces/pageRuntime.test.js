import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The page runtime ships inside the core (crates/eos-surface/assets) and runs in
// a sandboxed frame. There is no jsdom in this suite: the test hands the script
// a small DOM of its own, enough for the selectors the runtime uses.
const RUNTIME = readFileSync(
  fileURLToPath(new URL("../../../../crates/eos-surface/assets/page-runtime.js", import.meta.url)),
  "utf8",
);

function matchesOne(el, selector) {
  const m = selector.trim().match(/^([a-z]*)((?:\.[a-z-]+)*)((?:\[[^\]]+\])*)$/);
  if (!m) throw new Error(`selector not in the fake DOM: ${selector}`);
  const [, tag, classes, attrs] = m;
  if (tag && el.tag !== tag) return false;
  for (const c of classes.split(".").filter(Boolean)) if (!el.classes.has(c)) return false;
  for (const a of attrs.match(/\[[^\]]+\]/g) || []) {
    const [, name, value] = a.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
    if (!el.hasAttribute(name)) return false;
    if (value !== undefined && el.getAttribute(name) !== value) return false;
  }
  return true;
}
const matches = (el, selector) => selector.split(",").some((s) => matchesOne(el, s));

function element(tag, attrs = {}, children = []) {
  const el = {
    nodeType: 1, tag, attrs: { ...attrs }, children: [], parentNode: null, open: false,
    classes: new Set(),
    hasAttribute: (n) => n in el.attrs,
    getAttribute: (n) => (n in el.attrs ? el.attrs[n] : null),
    setAttribute: (n, v) => { el.attrs[n] = String(v); },
    removeAttribute: (n) => { delete el.attrs[n]; },
    closest(selector) {
      for (let node = el; node && node.nodeType === 1; node = node.parentNode) if (matches(node, selector)) return node;
      return null;
    },
    querySelectorAll: (selector) => all(el).filter((n) => n !== el && matches(n, selector)),
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 40 }),
    replaceWith(next) {
      const siblings = el.parentNode.children;
      siblings[siblings.indexOf(el)] = next;
      next.parentNode = el.parentNode;
    },
  };
  el.classList = {
    add: (c) => el.classes.add(c),
    remove: (c) => el.classes.delete(c),
    toggle: (c, on) => (on ? el.classes.add(c) : el.classes.delete(c)),
  };
  for (const child of children) { child.parentNode = el; el.children.push(child); }
  return el;
}
const all = (root) => [root, ...root.children.flatMap(all)];

function boot(body) {
  const sent = [];
  const listeners = {};
  const winListeners = {};
  const parent = { postMessage: (m) => sent.push(m) };
  const html = element("html", {}, [body]);
  html.scrollHeight = 900;
  const parsed = {};
  const document = {
    documentElement: html,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    querySelectorAll: (s) => all(html).filter((n) => matches(n, s)),
    querySelector: (s) => all(html).find((n) => matches(n, s)) || null,
    createElement: () => {
      const holder = { content: { firstElementChild: null } };
      Object.defineProperty(holder, "innerHTML", { set: (h) => { holder.content.firstElementChild = parsed[h] || null; } });
      return holder;
    },
  };
  const window = { parent, addEventListener: (type, fn) => { winListeners[type] = fn; } };
  new Function("window", "document", "setTimeout", RUNTIME)(window, document, (fn) => { window.flush = fn; return 1; });
  const click = (target) => {
    const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    listeners.click(event);
    return event;
  };
  const fromParent = (data) => winListeners.message({ source: parent, data });
  return { sent, click, fromParent, winListeners, listeners, document, parsed, window, parent };
}

let page;
let parts;
beforeEach(() => {
  parts = {
    chipAll: element("button", { "data-filter": "", "aria-pressed": "true" }),
    chipTools: element("button", { "data-filter": "tools", "aria-pressed": "false" }),
    story0: element("article", { "data-part": "story", "data-index": "0", "data-filter-of": "stories", "data-filter-value": "engine" }),
    story1: element("article", { "data-part": "story", "data-index": "1", "data-filter-of": "stories", "data-filter-value": "tools" }),
    link: element("a", { href: "https://example.com/undo" }),
    ask: element("button", { "data-ask": "ask", "data-part": "ask", "data-index": "1" }),
    good: element("button", { "data-button": "good", "data-part": "good" }),
    live: element("div", { "data-part": "desk", "data-live": "needs_you.summary" }),
    details: element("details", { "data-part": "more" }),
  };
  parts.story1.children.push(parts.link, parts.ask);
  parts.link.parentNode = parts.story1;
  parts.ask.parentNode = parts.story1;
  const bar = element("div", { "data-filters": "stories", "data-part": "filters" }, [parts.chipAll, parts.chipTools]);
  const body = element("body", {}, [bar, parts.story0, parts.story1, parts.good, parts.live, parts.details]);
  page = boot(body);
});

describe("page runtime", () => {
  it("says it is ready and names its live parts", () => {
    expect(page.sent[0]).toEqual({ type: "eos-page/ready", live: ["desk"] });
  });

  it("a filter chip hides the items of other values and marks itself pressed", () => {
    page.click(parts.chipTools);
    expect(parts.story0.hasAttribute("data-filter-hidden")).toBe(true);
    expect(parts.story1.hasAttribute("data-filter-hidden")).toBe(false);
    expect(parts.chipTools.getAttribute("aria-pressed")).toBe("true");
    page.click(parts.chipAll);
    expect(parts.story0.hasAttribute("data-filter-hidden")).toBe(false);
  });

  it("a button names itself and the row it sits in, never any argument", () => {
    page.click(parts.good);
    page.click(parts.ask);
    const acts = page.sent.filter((m) => m.type === "eos-page/act");
    expect(acts).toEqual([
      { type: "eos-page/act", button: "good", ask: false, index: null },
      { type: "eos-page/act", button: "ask", ask: true, index: 1 },
    ]);
  });

  it("a link never navigates the frame: the dashboard opens it, and the read is noted", () => {
    const event = page.click(parts.link);
    expect(event.defaultPrevented).toBe(true);
    expect(page.sent.at(-1)).toEqual({ type: "eos-page/open", href: "https://example.com/undo" });
    page.window.flush();
    expect(page.sent.at(-1)).toEqual({
      type: "eos-page/read", parts: [], links: [{ part: "story", index: 1, link: "https://example.com/undo" }],
    });
  });

  it("an opened disclosure is a read of its part", () => {
    parts.details.open = true;
    page.listeners.toggle({ target: parts.details });
    page.window.flush();
    expect(page.sent.at(-1)).toEqual({ type: "eos-page/read", parts: [{ part: "more", index: null }], links: [] });
  });

  it("in pointing mode a click picks the nearest part instead of acting", () => {
    page.fromParent({ type: "eos-page/mode", mode: "point" });
    expect(page.document.documentElement.classes.has("eos-pointing")).toBe(true);
    const event = page.click(parts.link);
    expect(event.defaultPrevented).toBe(true);
    expect(page.sent.at(-1)).toEqual({
      type: "eos-page/part", part: "story", index: 1, rect: { x: 10, y: 20, width: 300, height: 40 },
    });
    expect(parts.story1.classes.has("eos-pointed")).toBe(true);
    expect(page.sent.some((m) => m.type === "eos-page/open")).toBe(false);
    page.fromParent({ type: "eos-page/mode", mode: "read" });
    expect(parts.story1.classes.has("eos-pointed")).toBe(false);
  });

  it("swaps a live part only for HTML of the same part, and only from its parent", () => {
    const fresh = element("div", { "data-part": "desk", "data-live": "needs_you.summary" });
    const other = element("div", { "data-part": "lead" });
    page.parsed["<fresh>"] = fresh;
    page.parsed["<other>"] = other;
    page.winListeners.message({ source: {}, data: { type: "eos-page/swap", part: "desk", html: "<fresh>" } });
    expect(page.document.querySelector('[data-part="desk"]')).toBe(parts.live);
    page.fromParent({ type: "eos-page/swap", part: "desk", html: "<other>" });
    expect(page.document.querySelector('[data-part="desk"]')).toBe(parts.live);
    page.fromParent({ type: "eos-page/swap", part: "desk", html: "<fresh>" });
    expect(page.document.querySelector('[data-part="desk"]')).toBe(fresh);
  });

  it("ignores a mode it does not know", () => {
    page.fromParent({ type: "eos-page/mode", mode: "script" });
    page.click(parts.good);
    expect(page.sent.at(-1).type).toBe("eos-page/act");
  });
});
