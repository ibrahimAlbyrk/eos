import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
// Imported too, so a change to the stylesheet brings this test along (vitest related).
import "./eos.css";

// Read from disk: the test run turns imported stylesheets into empty modules.
const eosCss = readFileSync(new URL("./eos.css", import.meta.url), "utf8");
const foundationCss = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

// The top-level rules of a stylesheet, @-blocks (media queries) left out:
// [{ selector, decls: Map<property, value> }].
function topLevelRules(css) {
  const rules = [];
  let depth = 0;
  let head = "";
  let body = "";
  let skip = false;
  for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, "")) {
    if (depth === 0 && ch === ";") { head = ""; continue; }
    if (ch === "{") {
      if (depth === 0) { skip = head.trim().startsWith("@"); body = ""; }
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        if (!skip) rules.push({ selector: head.trim(), decls: declarations(body) });
        head = "";
      }
      continue;
    }
    if (depth === 0) head += ch;
    else body += ch;
  }
  return rules;
}

function declarations(body) {
  const decls = new Map();
  for (const part of body.split(";")) {
    const at = part.indexOf(":");
    if (at > 0) decls.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  return decls;
}

// The app's tokens (styles.css :root).
const TOKENS = new Map(
  topLevelRules(foundationCss).filter((r) => r.selector === ":root").flatMap((r) => [...r.decls].filter(([k]) => k.startsWith("--"))),
);

function resolve(value) {
  let v = value;
  for (let i = 0; i < 10 && v.includes("var("); i++) {
    v = v.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, name, fallback) => TOKENS.get(name) ?? fallback ?? "?");
  }
  return v.trim().toLowerCase();
}

const isHex = (v) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(v);

function luminance(hex) {
  const h = hex.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const RULES = topLevelRules(eosCss);
const ownGround = (rule) => {
  const bg = resolve(rule.decls.get("background") ?? rule.decls.get("background-color") ?? "");
  return isHex(bg) ? bg : null;
};
// The dark grounds Eos draws (lighter than #262626 counts as a light one).
const GROUNDS = [...new Set(RULES.map(ownGround).filter((g) => g && luminance(g) < luminance("#262626")))];
// Each text colour with the grounds it sits on: its own, or every dark ground.
const PAIRS = RULES.filter((r) => r.decls.has("color")).flatMap((r) => {
  const ground = ownGround(r);
  return (ground ? [ground] : GROUNDS).map((g) => ({ selector: r.selector, color: resolve(r.decls.get("color")), ground: g }));
});

describe("eos.css contrast", () => {
  it("reads Eos's grounds and its text pairs from the file", () => {
    expect(GROUNDS.sort()).toEqual(["#101010", "#171717", "#212121"]);
    expect(PAIRS).toContainEqual({ selector: '.eos-seg__opt[aria-checked="true"]', color: "#f5f5f5", ground: "#2f2f2f" });
    expect(PAIRS).toContainEqual({ selector: ".eos-label", color: "#8b8b8b", ground: "#212121" });
  });

  it("gives every text 4.5:1 on its ground", () => {
    const weak = PAIRS
      .map((p) => ({ ...p, ratio: isHex(p.color) ? Number(contrast(p.color, p.ground).toFixed(2)) : 0 }))
      .filter((p) => p.ratio < 4.5);
    expect(weak).toEqual([]);
  });

  it("never sets text in --fg-faint", () => {
    expect(eosCss.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain("--fg-faint");
    expect(PAIRS.filter((p) => p.color === TOKENS.get("--fg-faint"))).toEqual([]);
  });

  it("draws the focus ring 2px in the accent, offset 2, at 3:1 on every ground", () => {
    const ring = RULES.find((r) => r.selector.includes(":focus-visible"));
    const [, width, colour] = ring.decls.get("outline").match(/^(\S+) solid (.+)$/);
    expect([width, resolve(colour), ring.decls.get("outline-offset")]).toEqual(["2px", "#6ea4e8", "2px"]);
    for (const g of GROUNDS) expect(contrast("#6ea4e8", g)).toBeGreaterThanOrEqual(3);
  });

  it("follows the user's transparency and contrast settings", () => {
    expect(eosCss).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*\.eos-mode \{[^}]*--lg-pop-tint: var\(--pop\)/);
    expect(eosCss).toMatch(/@media \(prefers-contrast: more\) \{\s*\.eos-mode \{[^}]*--fg-dim: var\(--fg-mid\);[^}]*--line: #333/);
  });
});
