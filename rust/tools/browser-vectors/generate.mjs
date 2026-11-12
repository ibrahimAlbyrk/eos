#!/usr/bin/env node
// Writes rust/fixtures/browser/vectors.json: what today's TypeScript computes for the pure
// rules of the browser, for crates/eos-mod-browser.
//
//   node rust/tools/browser-vectors/generate.mjs            write
//   node rust/tools/browser-vectors/generate.mjs --check    fail when it would change
//
// Needs Node ≥ 23.6 and `npm ci` in contracts/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const OUT = path.join(REPO, "rust/fixtures/browser/vectors.json");
const load = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const { formatAXTree, roleOf, statesOf } = await load("infra/src/browser/snapshotFormatter.ts");
const { parseChord } = await load("infra/src/browser/keys.ts");
const { BrowserService, browserProfileDirFor } = await load("manager/modules/browser/BrowserService.ts");

// A small seeded generator: the corpus must be the same on every run.
let seed = 0x2f6e2b1;
const rnd = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};
const pick = (list) => list[Math.floor(rnd() * list.length)];
const maybe = (p, make) => (rnd() < p ? make() : undefined);

// ---- the accessibility tree -----------------------------------------------------------------

const ROLES = [
  "RootWebArea", "generic", "GenericContainer", "none", "presentation", "InlineTextBox", "LineBreak", "ignored",
  "StaticText", "heading", "button", "link", "textbox", "searchbox", "TextArea", "checkbox", "radio", "combobox",
  "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton",
  "PopUpButton", "ToggleButton", "DisclosureTriangle", "navigation", "banner", "main", "contentinfo",
  "complementary", "form", "region", "search", "dialog", "alertdialog", "article", "list", "table", "tablist",
  "menu", "menubar", "radiogroup", "group", "paragraph", "image", "listitem", "cell", "row", "", "Section",
];
const NAMES = [
  "", "Sign in", "  Search   the\n docs  ", "Çıkış yap — şimdi", "x".repeat(99), "y".repeat(100), "z".repeat(101),
  "long ".repeat(40), "quote \" and \\ slash", "tab\tand nbsp", "日本語のラベル", "emoji 😀 ok", 42, true, null,
  "line sep", "\u0001control",
];
const VALUES = ["", "hello", "v".repeat(59), "w".repeat(60), "u".repeat(61), "  spaced   out ", 50, 0.5, false, null];
const PROPS = [
  () => ({ name: "focusable", value: { value: pick([true, false, "true"]) } }),
  () => ({ name: "checked", value: { value: pick([true, false, "true", "false", "mixed"]) } }),
  () => ({ name: "pressed", value: { value: pick([true, false, "mixed", "true"]) } }),
  () => ({ name: "expanded", value: { value: pick([true, false, "true", "false"]) } }),
  () => ({ name: "disabled", value: { value: pick([true, false, "true"]) } }),
  () => ({ name: "selected", value: { value: pick([true, false]) } }),
  () => ({ name: "required", value: { value: pick([true, false, "true"]) } }),
  () => ({ name: "invalid", value: { value: pick(["false", "true", "grammar", "", true, false, 0, 1]) } }),
  () => ({ name: "level", value: { value: pick([1, 2, 3, "4", null]) } }),
  () => ({ name: "Focusable", value: { value: true } }),
  () => ({ name: "CHECKED", value: { value: true } }),
  () => ({ name: "editable", value: { value: "plaintext" } }),
  () => ({ name: "level" }),
  () => ({ name: "expanded", value: {} }),
];

function randomNode(id) {
  const node = { nodeId: String(id) };
  if (rnd() < 0.08) node.ignored = true;
  const role = pick(ROLES);
  if (rnd() < 0.95) node.role = { value: role };
  const name = pick(NAMES);
  if (rnd() < 0.8) node.name = { value: name };
  const value = maybe(0.25, () => pick(VALUES));
  if (value !== undefined) node.value = { value };
  const props = [];
  while (rnd() < 0.45) props.push(pick(PROPS)());
  if (props.length || rnd() < 0.2) node.properties = props;
  if (rnd() < 0.85) node.backendDOMNodeId = 1000 + id;
  return node;
}

function randomTree(size) {
  const nodes = [];
  for (let i = 0; i < size; i++) nodes.push(randomNode(i + 1));
  nodes[0].role = { value: "RootWebArea" };
  delete nodes[0].ignored;
  // Each node after the first hangs under an earlier one: a tree, in document order.
  for (let i = 1; i < size; i++) {
    const parent = nodes[Math.floor(rnd() * i)];
    (parent.childIds ??= []).push(nodes[i].nodeId);
    nodes[i].parentId = parent.nodeId;
  }
  if (rnd() < 0.1) (nodes[0].childIds ??= []).push("missing-id");
  return nodes;
}

const HAND_MADE = [
  [],
  [{ nodeId: "1", role: { value: "button" }, name: { value: "Alone" }, backendDOMNodeId: 5 }],
  [
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" }, childIds: ["2", "3", "4"] },
    { nodeId: "2", role: { value: "heading" }, name: { value: "Title" }, properties: [{ name: "level", value: { value: 1 } }], childIds: ["5"] },
    { nodeId: "5", role: { value: "StaticText" }, name: { value: "Title" } },
    { nodeId: "3", role: { value: "navigation" }, name: { value: "Main" }, childIds: ["6", "7"] },
    { nodeId: "6", role: { value: "link" }, name: { value: "Home" }, backendDOMNodeId: 11, properties: [{ name: "focusable", value: { value: true } }] },
    { nodeId: "7", role: { value: "link" }, name: { value: "Docs" }, backendDOMNodeId: 12 },
    { nodeId: "4", role: { value: "form" }, name: { value: "" }, childIds: ["8", "9", "10"] },
    { nodeId: "8", role: { value: "textbox" }, name: { value: "Email" }, value: { value: "a@b.c" }, backendDOMNodeId: 13, properties: [{ name: "required", value: { value: true } }, { name: "invalid", value: { value: "true" } }] },
    { nodeId: "9", role: { value: "checkbox" }, name: { value: "Remember" }, backendDOMNodeId: 14, properties: [{ name: "checked", value: { value: "mixed" } }] },
    { nodeId: "10", role: { value: "button" }, name: { value: "Sign in" }, properties: [{ name: "disabled", value: { value: true } }] },
  ],
  // A node id used twice: the later node wins the lookup.
  [
    { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
    { nodeId: "2", role: { value: "button" }, name: { value: "first" }, backendDOMNodeId: 1 },
    { nodeId: "2", role: { value: "link" }, name: { value: "second" }, backendDOMNodeId: 2 },
  ],
  // No root web area: the first node is the root.
  [
    { nodeId: "a", role: { value: "main" }, name: { value: "Content" }, childIds: ["b"] },
    { nodeId: "b", role: { value: "slider" }, name: { value: "Volume" }, value: { value: 50 }, backendDOMNodeId: 9 },
  ],
];

const axCases = [];
const addCase = (nodes, opts) => {
  const out = formatAXTree(structuredClone(nodes), opts);
  axCases.push({ nodes, options: opts, text: out.text, refs: out.refs, nextRefIndex: out.nextRefIndex });
};
for (const nodes of HAND_MADE) {
  for (const interactiveOnly of [true, false]) {
    addCase(nodes, { interactiveOnly, refStart: 0 });
    addCase(nodes, { interactiveOnly, depth: 1, refStart: 7 });
    addCase(nodes, { interactiveOnly, depth: 2, refStart: 0 });
  }
}
addCase(HAND_MADE[2], { interactiveOnly: true, rootBackendNodeId: 13, refStart: 3 });
addCase(HAND_MADE[2], { interactiveOnly: false, rootBackendNodeId: 9999, refStart: 3 });
for (let i = 0; i < 260; i++) {
  const nodes = randomTree(2 + Math.floor(rnd() * 40));
  const opts = { interactiveOnly: rnd() < 0.5, refStart: Math.floor(rnd() * 50) };
  const depth = maybe(0.3, () => 1 + Math.floor(rnd() * 4));
  if (depth !== undefined) opts.depth = depth;
  const scoped = maybe(0.15, () => pick(nodes).backendDOMNodeId);
  if (scoped !== undefined) opts.rootBackendNodeId = scoped;
  addCase(nodes, opts);
}

const nodeFacts = [];
for (let i = 0; i < 200; i++) {
  const node = randomNode(i);
  nodeFacts.push({ node, role: roleOf(node), states: statesOf(node) });
}

// ---- key chords -----------------------------------------------------------------------------

const CHORDS = [
  "Enter", "enter", "Tab", "Shift+Tab", "Escape", "Backspace", "Delete", "ArrowLeft", "ArrowUp", "ArrowRight",
  "ArrowDown", "Home", "End", "PageUp", "PageDown", "Space", "Control+a", "Ctrl+A", "Meta+c", "Cmd+V", "Command+z",
  "Alt+x", "Option+1", "Shift+a", "a", "A", "z", "5", "/", "+", "Control+Shift+p", "ctrl + alt + delete", " Enter ",
  "Shift+Enter", "Control+Enter", "Meta+Space", "Alt+Space", "ß", "é", "ı", "İ", "ŉ", "€", "",
  "+", "++", "Control+", "+a", "Hyper+a", "Control+Foo", "F5", "ab", "😀", "Shift+😀", "Control+Shift", "shift+ß",
];
const chords = CHORDS.map((chord) => {
  try {
    return { chord, ok: parseChord(chord) };
  } catch (e) {
    return { chord, error: e.message };
  }
});

// ---- policy -----------------------------------------------------------------------------------

function service(allowedOrigins) {
  return new BrowserService({
    engineFactory: () => { throw new Error("no engine in the vector run"); },
    getConfig: () => ({ enabled: true, chromePath: null, allowedOrigins, persistProfile: true, perSession: true }),
    bus: { publish() {} },
    log: { info() {}, warn() {} },
  });
}

const LISTS = [
  [],
  ["https://example.com"],
  ["example.com"],
  ["Example.COM", "  https://Docs.Example.com:8443  ", ""],
  ["localhost:5173", "127.0.0.1"],
  ["http://localhost:3000", "[::1]:8080", "[::1]"],
  ["   "],
];
const URLS = [
  "about:blank", "https://example.com/", "https://example.com:443/a?b#c", "http://example.com/", "https://EXAMPLE.com",
  "https://sub.example.com/", "https://example.com.evil.test/", "https://docs.example.com:8443/x",
  "https://docs.example.com/", "http://localhost:5173/app", "http://localhost:3000/", "https://localhost:3000/",
  "http://127.0.0.1:9000/", "http://[::1]:8080/", "http://[::1]/", "ftp://example.com/file", "file:///etc/hosts",
  "javascript:alert(1)", "data:text/html,hi", "not a url", "", "//example.com", "https://user:pw@example.com/",
  "https://example.com:80/", "http://example.com:80/", "HTTPS://Example.com/Path", "https://xn--mnchen-3ya.de/",
  "https://münchen.de/", "chrome://settings", "about:srcdoc", "https://exa mple.com/",
];
const navigation = [];
for (const allowed of LISTS) {
  const s = service(allowed);
  for (const url of URLS) {
    for (const actor of ["agent", "human"]) {
      let error = null;
      try { s.enforceNavPolicy(url, actor); } catch (e) { error = e.message; }
      navigation.push({ allowed, url, actor, error });
    }
  }
}

const s = service([]);
const HEADER_MAPS = [
  {},
  { Authorization: "Bearer x", "Proxy-Authorization": "y", Cookie: "a=b", "Set-Cookie": "c=d", Accept: "*/*" },
  { "x-api-key": "k", "X-Api_Key": "k", apikey: "k", "x-csrf-token": "t", "client-secret": "s", "x-session-id": "1" },
  { "www-authenticate": "Basic", author: "me", "x-authored-by": "me", "content-type": "text/html", etag: "1" },
  { "X-TOKEN": "t", tok: "en", "sec-ch-ua": "x", "ſession": "long s", "x-ape-key": "no" },
];
const PAYLOADS = [
  { ok: true },
  { headers: { cookie: "a", accept: "b" }, tabId: "t" },
  { request: { requestHeaders: { Authorization: "x" }, url: "u" }, list: [{ responseHeaders: { "set-cookie": "y", server: "z" } }, 5, "s", null] },
  { headers: { cookie: 1 } },
  { headers: ["cookie"] },
  { headers: {} },
  { Headers: { cookie: "kept name, redacted value" }, myHEADERS: { token: "x" }, headersish: { token: "kept" } },
  [{ headers: { auth: "x" } }],
  "plain",
  null,
];
const redaction = {
  headers: HEADER_MAPS.map((headers) => ({ headers, redacted: s.redactHeaders(headers) })),
  payloads: PAYLOADS.map((payload) => ({ payload, redacted: s.redactForAgent(payload) })),
};

const SESSIONS = ["global", "o-1a2b3c", "w-KID1", "../../etc", "a b/c\\d", "über", "名前", "😀", "a.b_c-d", "", "GLOBAL", "o:1"];
const profiles = SESSIONS.map((session) => ({
  session,
  folder: path.relative(path.join("/home", "browser"), browserProfileDirFor("/home", true, session)),
}));

const json = `${JSON.stringify({ ax: axCases, nodes: nodeFacts, chords, navigation, redaction, profiles })}\n`;
if (process.argv.includes("--check")) {
  if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== json) {
    console.error(`${path.relative(REPO, OUT)} is not what today's TypeScript computes: run this tool without --check`);
    process.exit(1);
  }
  console.log("browser vectors are current");
} else {
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  console.log(`${path.relative(REPO, OUT)}: ${axCases.length} trees, ${nodeFacts.length} nodes, ${chords.length} chords, ${navigation.length} navigations`);
}
