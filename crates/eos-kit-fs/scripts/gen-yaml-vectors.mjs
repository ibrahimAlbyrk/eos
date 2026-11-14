// Vectors for the Rust port of the `yaml` package's writer: values and what
// `stringify` (defaults, as the 0.1.x app's frontmatter writer called it)
// writes for them, plus whole frontmatter files.
//
//   node crates/eos-kit-fs/scripts/gen-yaml-vectors.mjs
//
// Object keys are emitted in code-point order so the Rust test, which reads
// the JSON into sorted maps, feeds the writer the same order.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { parse, stringify } from "yaml";

// The two lines of the 0.1.x app's frontmatter reader and writer.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const joinFrontmatter = (meta, body) => `---\n${stringify(meta).trimEnd()}\n---\n${body}`;

const byCodePoint = (a, b) => {
  const [x, y] = [[...a], [...b]];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
};
const sorted = (v) =>
  Array.isArray(v) ? v.map(sorted)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort(byCodePoint).map((k) => [k, sorted(v[k])]))
  : v;

// A small deterministic generator, so the file is the same on every run.
let seed = 0x2f6e2b1;
const rand = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};
const pick = (list) => list[Math.floor(rand() * list.length)];

const LOREM = "the quick brown fox jumps over the lazy dog while a writer folds long lines at eighty columns and keeps every word whole".split(" ");
const sentence = (words) => Array.from({ length: words }, () => pick(LOREM)).join(" ");

const strings = [
  "", " ", "plain", "two words", "trailing space ", " leading space", "colon: inside", "ends with colon:", "a #comment", "#hash first",
  "- dash first", "-", "?", "? question", "!bang", "&anchor", "*alias", "|pipe", ">gt", "'single'", '"double"', "it's", 'say "hi"',
  `both ' and "`, "%percent", "@at", "`tick", "[bracket", "{brace", "a, b", "true", "True", "FALSE", "null", "Null", "~", "yes", "no", "on",
  "42", "-7", "+7", "0o17", "017", "0x1F", "1.5", ".5", "5.", "1e3", "1E-3", ".inf", "-.INF", ".nan", "2026-01-01", "2026-01-01T00:00:00.000Z",
  "12:30", "1_000", "---", "--- x", "...", "... y", "%YAML", "a\n---\nb", "tab\there", "\ttab first", "line one\nline two", "line one\nline two\n",
  "line one\n\nline three", "trailing newlines\n\n", "\nleading newline", "\n\nleading two", "  indented first\nsecond", "first\n  indented second\nthird",
  "first\n\n  indented after blank\n\nlast", "ends with space \nnext", "next\n starts with space", "only\n", "\n", "\n\n", " \n", "a\n ", "a\n\t",
  "carriage\rreturn", "crlf\r\nline", "bell\u0007", "nul\u0000", "escape\u001b[0m", "del\u007f", "nel\u0085x", "nbsp\u00a0x", "ls\u2028x", "ps\u2029x",
  "bom\ufeffx", "emoji 😀 astral", "türkçe karakterler: ığüşöç", "日本語のテキスト", "back\\slash", "C:\\Users\\me", "a\\nb", "quote \" then \\ slash",
  "key: value # not a comment", "http://example.com/a?b=c#d", "user@example.com", "50%", "a | b", "a > b", "x: y: z", "::", ":", "a:b", "- - -",
  sentence(12), sentence(20), sentence(40), `${sentence(14)}: ${sentence(14)}`, `"${sentence(18)}"`, `'${sentence(18)}'`, `${sentence(18)} #${sentence(4)}`,
  `${sentence(10)}\n${sentence(25)}\n\n${sentence(8)}`, `${sentence(30)}\n`, `  ${sentence(30)}\n${sentence(30)}`, `${sentence(16)}\n  - ${sentence(16)}\n  - ${sentence(4)}\n${sentence(3)}`,
  `${sentence(10)}😀${sentence(10)}😀😀${sentence(10)}`, "x".repeat(79), "x".repeat(80), "x".repeat(81), "x".repeat(200), `${"y".repeat(60)} ${"z".repeat(60)}`,
  `${"word ".repeat(15)}word`, `${"word ".repeat(16)}word`, `${"word ".repeat(17)}word`, `it's ${sentence(20)}`, `say "${sentence(20)}"`, `tab\t${sentence(20)}`,
  `bell\u0007 ${sentence(20)}`, `${sentence(8)}\u0007\n${sentence(20)}\n${sentence(3)}`, `first line\n${"long ".repeat(20)}\nlast`, `${sentence(13)}  two spaces  ${sentence(13)}`,
  `${sentence(13)}\n\n\n${sentence(13)}`, `a ${"b".repeat(100)} c`, `${sentence(9)}: ${"b".repeat(100)}`, `trailing space after long text ${sentence(15)} `,
];

const ALPHABET = ["a", "b", "word", " ", " ", " ", " ", "\n", "\n", ":", ": ", "#", " #", "-", "- ", "'", '"', "\\", "\t", "😀", "é", ",", "[", "{", "%", "!", "0", "1", ".", "---", "\u0007", "  "];
const randomString = () => Array.from({ length: 1 + Math.floor(rand() * (rand() < 0.3 ? 60 : 12)) }, () => pick(ALPHABET)).join("");
for (let i = 0; i < 250; i++) strings.push(randomString());

const values = [
  null, true, false, 0, 1, -1, 42, 1.5, -2.25, 1e21, 1e-7, 123456789.125, 1767225600000, 9007199254740991,
  [], {}, [[]], [{}], { a: [] }, { a: {} }, { a: null }, { a: null, b: null }, [null], [null, null],
  ["a", "b"], [["a", "b"], ["c"]], [{ a: 1, b: 2 }, { c: 3 }], { a: { b: { c: { d: "deep" } } } }, { a: ["x", ["y", ["z"]]] },
  { list: [{ name: "one", tags: ["a", "b"] }, { name: "two", tags: [] }] },
  { "key with space": 1, "key: colon": 2, "#hash": 3, "": 4, "true": 5, "4 2": 6, "null": 7, "-": 8, "a\nb": 9, "'q'": 10, "é": 11, "😀": 12, "---": 13, "tab\tkey": 14 },
  { ["k".repeat(100)]: "long key", ["w ".repeat(60).trim()]: sentence(30) },
  { ["k".repeat(1100)]: "a key too long for one line", next: 1 },
  { ["k".repeat(1100)]: ["x"], ["j".repeat(1100)]: { a: 1 } },
  { text: sentence(40), nested: { text: sentence(40), deeper: { text: sentence(40), list: [sentence(40), { text: sentence(40) }] } } },
  { why: `${sentence(20)}\n${sentence(20)}`, evidence: [{ quote: `"${sentence(22)}"`, chat: "w_1" }, { quote: `${sentence(9)}\n\n${sentence(30)}\n`, chat: "w_2" }] },
  { a: "---", b: "...", c: "%x", d: { e: "---", f: "a\n---\nb" } },
  { block: "one\ntwo\n", after: "x" }, { block: "one\ntwo\n\n", after: "x" }, { block: "one\ntwo", after: "x" }, [`one\ntwo\n\n`, "x"], [[`one\ntwo\n`]],
  { " lead": " lead\nmore", "trail ": "trail \nmore" },
];
for (const s of strings) {
  values.push(s, { k: s }, [s], { outer: { inner: s } }, { list: [s, { k: s }] }, { ["a".repeat(30)]: s }, { ["a".repeat(70)]: s });
}

// What stringify(value) is, for each value.
const vectors = values.map(sorted).map((value) => ({ value, yaml: stringify(value) }));

// Whole files: metadata like a page's and a memory's, and bodies that look like fences.
const metas = [
  { id: "p_x1", title: "A page", project: null, agentId: null, rev: 1, createdAt: 1767225600000, updatedAt: 1767225600123, updatedBy: "user" },
  { id: "p_x2", title: `Notes: ${sentence(14)}`, project: "/Users/me/Projects/eos", agentId: "w_abc", rev: 12, createdAt: 1767225600000, updatedAt: 1767229200000, updatedBy: "agent" },
  { id: "m_x1", category: "preference", scope: { kind: "global" }, tier: "always", status: "kept", source: { kind: "user" }, rev: 0, createdAt: 1767225600000, updatedAt: 1767225600000 },
  { id: "m_x2", category: "workflow", domain: "git", scope: { kind: "project", project: "git:github.com/me/eos" }, tier: "searchable", status: "pending",
    source: { kind: "dream", runId: "d_1" },
    proposal: { op: "update", target: "m_x1", why: `${sentence(26)}.`, support: 3, evidence: [{ chat: "w_1", day: "2026-01-01", quote: `"${sentence(18)}"` }, { chat: "w_2", day: "2026-01-02", quote: `${sentence(12)}\n${sentence(12)}` }] },
    rev: 4, createdAt: 1767225600000, updatedAt: 1767232800000 },
  { title: "yes", note: "ends in spaces   ", empty: "", list: [] },
];
const bodies = ["", "body\n", "# Title\n\ntext\n", "---\nlooks like a fence\n---\n", "no newline at end", "\n\nleading blank lines\n", "crlf\r\nbody\r\n"];
const files = [];
for (const meta of metas) for (const body of bodies) {
  const file = joinFrontmatter(sorted(meta), body);
  const m = file.match(FRONTMATTER_RE);
  files.push({ meta: sorted(meta), body, file, readBack: parse(m[1]), bodyBack: file.slice(m[0].length) });
}

const out = join(import.meta.dirname, "..", "tests", "fixtures", "yaml-vectors.json");
writeFileSync(out, `${JSON.stringify({ vectors, files })}\n`);
console.log(`${vectors.length} values, ${files.length} files`);
