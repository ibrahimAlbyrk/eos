// The ONLY module that knows Mermaid exists. Everything else deals in
// placeholder <div class="mermaid-block"> nodes and an opaque renderMermaid()
// — Mermaid's API, its lazy chunk, and the Eos-token → themeVariables mapping
// all live here (dependency inversion). Mermaid ships as its own async chunk:
// the dynamic import() below is the only reference, so it loads on the first
// real diagram, never on a transcript that has none.

let mermaidPromise = null;

function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

// --- Source normalization -------------------------------------------------
// Pure, single-responsibility layer that neutralizes agent-authored Mermaid
// quirks BEFORE mermaid ever sees the source. Kept as an ordered list of small
// src->src rules so a future breakage slots in as one more rule, never a
// rewrite. Runs in exactly one place (renderMermaid + parseMermaid), so both
// surfaces — the rendered message and the live preview — and the SVG cache all
// see the same normalized text.

// Encode only a BARE ';' as the entity '#59;' (mermaid renders it as a literal
// ';'). Existing entities ('&amp;', '#59;', '#lt;' …) are matched whole and
// returned untouched so we never double-encode a ';' that already terminates
// one.
function neutralizeSemicolons(text) {
  return text.replace(/&#?\w+;|#\w+;|;/g, (m) => (m === ";" ? "#59;" : m));
}

const SEQ_HEADER = /^\s*sequenceDiagram\b/m;
// An actor-arrow-actor message line, capturing everything up to and including
// the first ':' (the structural prefix) separately from the descriptive text.
// Arrow alternation is longest-first so e.g. '-->>' wins over '->'.
const SEQ_MESSAGE =
  /^(\s*[A-Za-z0-9_]+\s*(?:<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->)[+-]?\s*[A-Za-z0-9_]+\s*:)(.*)$/;
// A note line: 'Note (left of|right of|over) <actors>: text'.
const SEQ_NOTE = /^(\s*[Nn]ote\s+(?:left of|right of|over)\s+[^:\n]+:)(.*)$/;

// Rule 1 — a bare ';' in sequence descriptive text. Mermaid 11 treats ';' as a
// global statement separator, so a ';' in a message body splits the statement
// and the trailing prose fails to parse. We rewrite ONLY the ';' that follows
// the ':' on a message/note line, and ONLY inside a sequenceDiagram — so
// flowchart terminators (`graph TD; A-->B;`), state-diagram labels, class
// members, etc. are provably untouched (non-sequence sources are returned
// byte-identical).
//
// Known trade-off: the rare `A->>B: x ; C->>D: y` form, where the author meant
// the ';' to separate TWO messages on one line, is instead rendered as a single
// message with a literal ';'. Prose semicolons in agent output vastly outnumber
// this inline-statement style, so the conservative win is worth it.
function fixSequenceSemicolons(src) {
  if (!SEQ_HEADER.test(src)) return src;
  return src
    .split("\n")
    .map((line) => {
      const msg = SEQ_MESSAGE.exec(line);
      if (msg) return msg[1] + neutralizeSemicolons(msg[2]);
      const note = SEQ_NOTE.exec(line);
      if (note) return note[1] + neutralizeSemicolons(note[2]);
      return line;
    })
    .join("\n");
}

const RULES = [fixSequenceSemicolons];

export function sanitizeMermaidSource(src) {
  return RULES.reduce((s, rule) => rule(s), src);
}

// khroma (Mermaid's color engine) needs concrete colors, not var(--x): resolve
// the Eos design tokens to their computed hex/rgb off <html> at init time so the
// diagram inherits whatever the active theme actually painted.
function themeVarsFor() {
  const s = getComputedStyle(document.documentElement);
  const v = (name) => s.getPropertyValue(name).trim();
  const surface = v("--surface");
  const surface2 = v("--surface-2");
  const surface3 = v("--surface-3");
  const fg = v("--fg");
  const fgDim = v("--fg-dim");
  const borderStrong = v("--border-strong");
  return {
    background: surface,
    mainBkg: surface2,
    primaryColor: surface2,
    secondaryColor: surface3,
    tertiaryColor: surface3,
    primaryTextColor: fg,
    textColor: fg,
    nodeTextColor: fg,
    titleColor: fg,
    primaryBorderColor: borderStrong,
    nodeBorder: borderStrong,
    lineColor: fgDim,
    edgeLabelBackground: surface2,
    fontFamily: v("--font-ui"),
    // Semantic accents for active/error/success states.
    activeTaskBkgColor: v("--accent"),
    errorBkgColor: v("--err"),
    errorTextColor: v("--err"),
    successColor: v("--ok"),
  };
}

// Re-init (and re-resolve the concrete colors) only when the theme string
// changes; startOnLoad:false keeps Mermaid from scanning the DOM on its own,
// securityLevel:"strict" makes it sanitize the SVG and drop any script/handlers.
//
// htmlLabels:false is the reason flowchart/sequence/state diagrams render at
// all in our WKWebView shell. With htmlLabels on (Mermaid's default for those
// types) node/edge labels are HTML <div>s wrapped in SVG <foreignObject>; the
// macOS WKWebView fails to lay foreignObject out (0-size), so the whole diagram
// collapses to an empty box — no error, because the SVG's own viewBox is still
// valid. Pie has no htmlLabels and always survived, which is exactly what we
// saw. Forcing htmlLabels:false renders every label as native SVG <text>, which
// WKWebView lays out fine (confirmed by a headless-Chromium repro: identical
// output, foreignObject count drops flowchart 10→0 / state 6→0, all sizes
// non-zero). flowchart needs its own nested flag; the top-level one covers the
// rest.
let initializedTheme = null;

async function ensureInit(theme) {
  const mermaid = await loadMermaid();
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      themeVariables: themeVarsFor(),
    });
    initializedTheme = theme;
  }
  return mermaid;
}

// Mermaid v11 sizes flowchart/sequence/state diagrams by MEASURING rendered text
// (getBBox); pie et al. use fixed geometry and skip measurement. In WKWebView
// getBBox returns 0 unless the element mermaid renders into is attached to the
// live document AND has a real (laid-out, non-zero) box — mermaid's default temp
// node isn't reliably laid out here, so every text-measured diagram collapses to
// a 0-size SVG (a blank box) while pie survives. Passing a persistent offscreen
// host as render()'s 3rd arg (svgContainingElement) gives measurement a real box.
// Off-screen via position+left (NOT display:none, which also zeros getBBox) and
// a concrete width so text actually lays out; mermaid removes its temp div after
// each render, so one shared host is reused (renders run serially — no races).
let measureHost = null;
function ensureMeasureHost() {
  if (measureHost && measureHost.isConnected) return measureHost;
  measureHost = document.createElement("div");
  measureHost.setAttribute("aria-hidden", "true");
  measureHost.style.cssText =
    "position:absolute;left:-99999px;top:0;width:1000px;height:auto;visibility:hidden;pointer-events:none;";
  document.body.appendChild(measureHost);
  return measureHost;
}

// A diagram whose text couldn't be measured collapses to a 0-size SVG (viewBox
// "0 0 0 0"). Detect that so the caller can fall back to raw source instead of
// silently showing a blank box — render() does NOT throw in this case.
function svgCollapsed(svg) {
  const m = /viewBox="([^"]*)"/i.exec(svg);
  if (!m) return false;
  const [, , w, h] = m[1].trim().split(/[\s,]+/).map(Number);
  return !(w > 0 && h > 0);
}

// Bounded LRU SVG cache keyed by theme + src — the same diagram in the same
// theme renders identically, so a re-mounted transcript reuses the SVG instead
// of paying for another mermaid.render(). Mirrors lib/markdown.js's cache shape.
const MAX_CACHE = 200;
const cache = new Map();

export async function renderMermaid(id, src, theme) {
  // Normalize before the cache lookup so the key reflects what mermaid actually
  // parses — two raw sources that normalize identically share one cache entry.
  const normalized = sanitizeMermaidSource(src);
  const key = theme + "\x00" + normalized;
  const hit = cache.get(key);
  if (hit !== undefined) return { svg: hit };
  const mermaid = await ensureInit(theme);
  const { svg } = await mermaid.render(id, normalized, ensureMeasureHost());
  if (svgCollapsed(svg)) throw new Error("Diagram rendered with zero size");
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, svg);
  return { svg };
}

// Non-throwing validity check (returns false on invalid) — lets callers gate on
// "does this parse yet" during streaming without a try/catch around render.
export async function parseMermaid(src) {
  const mermaid = await loadMermaid();
  return mermaid.parse(sanitizeMermaidSource(src), { suppressErrors: true });
}
