// The `ui` markup of a visual answer: XML-ish JSX that only references data.
//
//   <Tag a="text" b='text' c={json} flag>children</Tag>   <Tag a="x"/>
//
// Text children are inline markdown (kept as strings). `{…}` attribute values are
// JSON (read forgivingly), never JS. <Code> is raw text up to </Code>. Dependency-
// free so the UI parses the same way the daemon validates. Never throws: problems
// come back as `errors` with 1-based line/col.
//
// parseMarkup(src) reads a whole document; an element left open at the end is
// closed implicitly (and reported). parsePartial(prefix) reads a document that is
// still being streamed and returns only what is settled: closed elements, plus an
// open container that already holds a closed element (flagged `partial`); an
// unfinished tag, an open leaf and trailing text are dropped.

import { parseLooseJson } from "./partial-json.ts";

export interface MarkupPos {
  line: number;
  col: number;
  offset: number;
}

export interface MarkupElement {
  type: "element";
  name: string;
  // Quoted values are strings, `{…}` values parsed JSON, bare flags `true`.
  attrs: Record<string, unknown>;
  // Where each attribute starts, for error messages.
  attrPos: Record<string, MarkupPos>;
  children: MarkupNode[];
  // The element's own text: its text children joined (inline markdown), or the
  // raw code of a <Code> element. "" when it has none.
  text: string;
  pos: MarkupPos;
  selfClosing: boolean;
  // parsePartial only: still open, children so far are complete.
  partial?: true;
}

export interface MarkupText {
  type: "text";
  text: string;
  pos: MarkupPos;
}

export type MarkupNode = MarkupElement | MarkupText;

export interface MarkupError {
  message: string;
  line: number;
  col: number;
}

export interface MarkupParseResult {
  nodes: MarkupNode[];
  errors: MarkupError[];
}

// Elements whose content is raw text, never parsed for tags.
export const RAW_TEXT_TAGS: ReadonlySet<string> = new Set(["Code"]);

const NAME_START = /[A-Za-z]/;
const NAME_CHAR = /[A-Za-z0-9_.-]/;
const ATTR_START = /[A-Za-z_:@]/;
const ATTR_CHAR = /[A-Za-z0-9_:.@-]/;

export function parseMarkup(src: unknown): MarkupParseResult {
  return run(src, false);
}

export function parsePartial(prefix: unknown): MarkupParseResult {
  return run(prefix, true);
}

// Depth-first visit of every element; depth 1 = top level.
export function walkMarkup(
  nodes: readonly MarkupNode[],
  visit: (el: MarkupElement, depth: number, parent: MarkupElement | null) => void,
): void {
  const step = (list: readonly MarkupNode[], depth: number, parent: MarkupElement | null): void => {
    for (const n of list) {
      if (n.type !== "element") continue;
      visit(n, depth, parent);
      step(n.children, depth + 1, n);
    }
  };
  step(nodes, 1, null);
}

export function markupDepth(nodes: readonly MarkupNode[]): number {
  let max = 0;
  walkMarkup(nodes, (_el, depth) => {
    if (depth > max) max = depth;
  });
  return max;
}

// `<Carousel of="places">` — the start tag with its identifying attributes, for
// messages the model can locate.
const KEY_ATTRS = ["of", "pick", "bind", "type", "title", "label", "expr"];

export function tagLabel(el: MarkupElement): string {
  const parts: string[] = [el.name];
  for (const k of KEY_ATTRS) {
    if (parts.length > 2) break;
    const v = el.attrs[k];
    if (typeof v === "string") parts.push(`${k}="${v.length > 24 ? `${v.slice(0, 23)}…` : v}"`);
  }
  return `<${parts.join(" ")}>`;
}

// ---- parser ------------------------------------------------------------------

interface Frame {
  el: MarkupElement;
  // Source offset where the text run after the last child began.
  textStart: number;
}

interface Ctx {
  s: string;
  i: number;
  partial: boolean;
  errors: MarkupError[];
  lineStarts: number[];
  root: MarkupNode[];
  stack: Frame[];
}

function run(input: unknown, partial: boolean): MarkupParseResult {
  if (typeof input !== "string") {
    return { nodes: [], errors: [{ message: "ui must be a string", line: 1, col: 1 }] };
  }
  const ctx: Ctx = { s: input, i: 0, partial, errors: [], lineStarts: lineStarts(input), root: [], stack: [] };
  let textStart = 0;
  while (ctx.i < ctx.s.length) {
    const lt = ctx.s.indexOf("<", ctx.i);
    if (lt < 0) {
      ctx.i = ctx.s.length;
      break;
    }
    const next = ctx.s[lt + 1];
    if (ctx.s.startsWith("<!--", lt)) {
      pushText(ctx, textStart, lt);
      const close = ctx.s.indexOf("-->", lt + 4);
      if (close < 0) {
        if (!partial) err(ctx, lt, "comment is never closed (missing -->)");
        ctx.i = ctx.s.length;
        textStart = ctx.s.length;
        break;
      }
      ctx.i = close + 3;
      textStart = ctx.i;
      continue;
    }
    if (next === "/" && NAME_START.test(ctx.s[lt + 2] ?? "")) {
      const end = ctx.s.indexOf(">", lt);
      if (end < 0) {
        // `</Sta` at the end of a stream — the close is still being written.
        if (!partial) err(ctx, lt, "closing tag is never finished (missing >)");
        pushText(ctx, textStart, lt);
        ctx.i = ctx.s.length;
        textStart = ctx.s.length;
        break;
      }
      pushText(ctx, textStart, lt);
      const name = ctx.s.slice(lt + 2, end).trim();
      closeTag(ctx, name, lt);
      ctx.i = end + 1;
      textStart = ctx.i;
      continue;
    }
    if (next !== undefined && NAME_START.test(next)) {
      const tag = readStartTag(ctx, lt);
      if (!tag) {
        // Unfinished start tag at the end of the input.
        if (!partial) err(ctx, lt, "tag is never finished (missing > or />)");
        pushText(ctx, textStart, lt);
        ctx.i = ctx.s.length;
        textStart = ctx.s.length;
        break;
      }
      pushText(ctx, textStart, lt);
      const el = tag.el;
      if (tag.selfClosing) {
        appendChild(ctx, el);
        textStart = ctx.i;
        continue;
      }
      if (RAW_TEXT_TAGS.has(el.name)) {
        const closeAt = ctx.s.indexOf(`</${el.name}`, ctx.i);
        if (closeAt < 0) {
          if (!partial) {
            err(ctx, lt, `<${el.name}> opened on line ${el.pos.line} is never closed`);
            setRaw(el, ctx.s.slice(ctx.i), posAt(ctx, ctx.i));
            appendChild(ctx, el);
          }
          ctx.i = ctx.s.length;
          textStart = ctx.s.length;
          break;
        }
        const gt = ctx.s.indexOf(">", closeAt);
        if (gt < 0) {
          if (!partial) {
            err(ctx, closeAt, "closing tag is never finished (missing >)");
            setRaw(el, ctx.s.slice(ctx.i, closeAt), posAt(ctx, ctx.i));
            appendChild(ctx, el);
          }
          ctx.i = ctx.s.length;
          textStart = ctx.s.length;
          break;
        }
        setRaw(el, ctx.s.slice(ctx.i, closeAt), posAt(ctx, ctx.i));
        appendChild(ctx, el);
        ctx.i = gt + 1;
        textStart = ctx.i;
        continue;
      }
      appendChild(ctx, el);
      ctx.stack.push({ el, textStart: ctx.i });
      textStart = ctx.i;
      continue;
    }
    // A literal "<" (e.g. "a < b") stays in the text.
    ctx.i = lt + 1;
  }
  finish(ctx, textStart);
  return { nodes: ctx.root, errors: ctx.errors };
}

function finish(ctx: Ctx, textStart: number): void {
  if (!ctx.partial) {
    pushText(ctx, textStart, ctx.s.length);
    while (ctx.stack.length) {
      const f = ctx.stack.pop() as Frame;
      err(ctx, f.el.pos.offset, `<${f.el.name}> opened on line ${f.el.pos.line} is never closed`);
      finalizeText(f.el);
    }
    return;
  }
  // Streaming: trailing text may be cut mid-word — drop it. Open elements stay
  // only when they already hold a closed element; the innermost go first.
  while (ctx.stack.length) {
    const f = ctx.stack.pop() as Frame;
    const el = f.el;
    const parentList = ctx.stack.length ? ctx.stack[ctx.stack.length - 1].el.children : ctx.root;
    while (el.children.length && el.children[el.children.length - 1].type === "text") el.children.pop();
    if (el.children.some((c) => c.type === "element")) {
      el.partial = true;
      finalizeText(el);
    } else {
      const idx = parentList.lastIndexOf(el);
      if (idx >= 0) parentList.splice(idx, 1);
    }
  }
}

function lineStarts(s: string): number[] {
  const out = [0];
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

function posAt(ctx: Ctx, offset: number): MarkupPos {
  const ls = ctx.lineStarts;
  let lo = 0;
  let hi = ls.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ls[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: offset - ls[lo] + 1, offset };
}

function err(ctx: Ctx, offset: number, message: string): void {
  const p = posAt(ctx, offset);
  ctx.errors.push({ message, line: p.line, col: p.col });
}

function appendChild(ctx: Ctx, node: MarkupNode): void {
  if (ctx.stack.length) ctx.stack[ctx.stack.length - 1].el.children.push(node);
  else ctx.root.push(node);
}

function pushText(ctx: Ctx, from: number, to: number): void {
  if (to <= from) return;
  const text = normalizeText(ctx.s.slice(from, to));
  if (!text) return;
  appendChild(ctx, { type: "text", text, pos: posAt(ctx, from + leadingWs(ctx.s, from, to)) });
}

function leadingWs(s: string, from: number, to: number): number {
  let n = 0;
  while (from + n < to && /\s/.test(s[from + n])) n++;
  return n;
}

function closeTag(ctx: Ctx, name: string, at: number): void {
  if (!ctx.stack.length) {
    err(ctx, at, `</${name}> has no matching open tag`);
    return;
  }
  let idx = -1;
  for (let k = ctx.stack.length - 1; k >= 0; k--) {
    if (ctx.stack[k].el.name === name) {
      idx = k;
      break;
    }
  }
  if (idx < 0) {
    err(ctx, at, `</${name}> has no matching open tag (open: <${ctx.stack[ctx.stack.length - 1].el.name}>)`);
    return;
  }
  while (ctx.stack.length > idx + 1) {
    const f = ctx.stack.pop() as Frame;
    err(ctx, f.el.pos.offset, `<${f.el.name}> opened on line ${f.el.pos.line} is closed by </${name}>`);
    finalizeText(f.el);
  }
  const f = ctx.stack.pop() as Frame;
  finalizeText(f.el);
}

function finalizeText(el: MarkupElement): void {
  if (RAW_TEXT_TAGS.has(el.name)) return;
  el.text = el.children
    .filter((c): c is MarkupText => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function setRaw(el: MarkupElement, raw: string, pos: MarkupPos): void {
  const code = dedent(raw.replace(/^[ \t]*\r?\n/, "").replace(/\s+$/, ""), true);
  el.text = code;
  el.children = code ? [{ type: "text", text: code, pos }] : [];
}

// Dedent, trim blank edges; internal newlines are kept (markdown paragraphs).
function normalizeText(raw: string): string {
  if (!/\S/.test(raw)) return "";
  return dedent(raw).trim();
}

// The first line follows the tag on the same line, so it sets no indent — unless
// it starts the block (raw code after its opening newline).
function dedent(raw: string, includeFirst = false): string {
  const lines = raw.split("\n");
  let min = Infinity;
  for (let k = includeFirst ? 0 : 1; k < lines.length; k++) {
    const l = lines[k];
    if (!/\S/.test(l)) continue;
    const ind = /^[ \t]*/.exec(l)?.[0].length ?? 0;
    if (ind < min) min = ind;
  }
  if (!Number.isFinite(min) || min === 0) return lines.join("\n");
  return lines
    .map((l, k) => (k === 0 && !includeFirst ? l : l.slice(Math.min(min, /^[ \t]*/.exec(l)?.[0].length ?? 0))))
    .join("\n");
}

interface StartTag {
  el: MarkupElement;
  selfClosing: boolean;
}

// Reads `<Name attrs… >` or `/>` starting at `lt`; null when the input ends first.
function readStartTag(ctx: Ctx, lt: number): StartTag | null {
  const s = ctx.s;
  let i = lt + 1;
  const nameStart = i;
  while (i < s.length && NAME_CHAR.test(s[i])) i++;
  if (i >= s.length) return null;
  const el: MarkupElement = {
    type: "element",
    name: s.slice(nameStart, i),
    attrs: {},
    attrPos: {},
    children: [],
    text: "",
    pos: posAt(ctx, lt),
    selfClosing: false,
  };
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) return null;
    const c = s[i];
    if (c === ">") {
      ctx.i = i + 1;
      return { el, selfClosing: false };
    }
    if (c === "/") {
      if (i + 1 >= s.length) return null;
      if (s[i + 1] === ">") {
        el.selfClosing = true;
        ctx.i = i + 2;
        return { el, selfClosing: true };
      }
      err(ctx, i, `unexpected "/" in <${el.name}>`);
      i++;
      continue;
    }
    if (!ATTR_START.test(c)) {
      // A stray character (a quote, a brace) — report it and move on so one slip
      // doesn't swallow the rest of the document.
      err(ctx, i, `unexpected "${c}" in <${el.name}>`);
      i++;
      continue;
    }
    const attrStart = i;
    while (i < s.length && ATTR_CHAR.test(s[i])) i++;
    if (i >= s.length) return null;
    const name = s.slice(attrStart, i);
    const apos = posAt(ctx, attrStart);
    let j = i;
    while (j < s.length && /[ \t]/.test(s[j])) j++;
    if (j >= s.length) return null;
    if (s[j] !== "=") {
      setAttr(ctx, el, name, true, apos);
      continue;
    }
    j++;
    while (j < s.length && /\s/.test(s[j])) j++;
    if (j >= s.length) return null;
    const q = s[j];
    if (q === '"' || q === "'") {
      const end = findQuote(s, j + 1, q);
      if (end < 0) {
        if (ctx.partial) return null;
        err(ctx, j, `attribute ${name} is missing its closing ${q}`);
        setAttr(ctx, el, name, decodeEntities(s.slice(j + 1).replace(new RegExp(`\\\\${q}`, "g"), q)), apos);
        ctx.i = s.length;
        return null;
      }
      const raw = s.slice(j + 1, end).replace(new RegExp(`\\\\${q}`, "g"), q);
      setAttr(ctx, el, name, decodeEntities(raw), apos);
      i = end + 1;
      continue;
    }
    if (q === "{") {
      const end = findBrace(s, j);
      if (end < 0) return null;
      const body = s.slice(j + 1, end).trim();
      const parsed = parseLooseJson(body);
      if (parsed.ok) {
        setAttr(ctx, el, name, parsed.value, apos);
      } else {
        err(ctx, j, `attribute ${name}={…} is not valid JSON (${parsed.error}); {…} holds JSON only, use quotes for text`);
        setAttr(ctx, el, name, body, apos);
      }
      i = end + 1;
      continue;
    }
    // Unquoted value: up to whitespace or the end of the tag.
    let k = j;
    while (k < s.length && !/[\s>]/.test(s[k]) && !(s[k] === "/" && s[k + 1] === ">")) k++;
    if (k >= s.length) return null;
    setAttr(ctx, el, name, decodeEntities(s.slice(j, k)), apos);
    i = k;
  }
}

function setAttr(ctx: Ctx, el: MarkupElement, name: string, value: unknown, pos: MarkupPos): void {
  if (Object.prototype.hasOwnProperty.call(el.attrs, name)) {
    ctx.errors.push({ message: `<${el.name}> repeats attribute ${name}`, line: pos.line, col: pos.col });
  }
  Object.defineProperty(el.attrs, name, { value, enumerable: true, writable: true, configurable: true });
  Object.defineProperty(el.attrPos, name, { value: pos, enumerable: true, writable: true, configurable: true });
}

// The closing quote, skipping backslash-escaped ones (models sometimes write \").
function findQuote(s: string, from: number, q: string): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === q) {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}

// The `}` that closes the `{` at `open`, skipping strings and nested brackets.
function findBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < s.length && s[k] !== c) k += s[k] === "\\" ? 2 : 1;
      if (k >= s.length) return -1;
      i = k;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return c === "}" ? i : -1;
    }
  }
  return -1;
}

const ENTITIES: Record<string, string> = { quot: '"', apos: "'", "#39": "'", lt: "<", gt: ">", amp: "&" };

function decodeEntities(v: string): string {
  return v.indexOf("&") < 0 ? v : v.replace(/&(quot|apos|#39|lt|gt|amp);/g, (_m, k: string) => ENTITIES[k]);
}
