import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAXTree, type AXNodeLike } from "../browser/snapshotFormatter.ts";
import { parseChord } from "../browser/keys.ts";

// A small realistic tree: RootWebArea → generic (collapsed) → heading, link,
// StaticText, textbox (required, valued), checkbox (checked), named nav.
const NODES: AXNodeLike[] = [
  { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Doc" }, childIds: ["2"] },
  { nodeId: "2", role: { value: "genericContainer" }, childIds: ["3", "4", "5", "6", "7", "8"], backendDOMNodeId: 2 },
  { nodeId: "3", role: { value: "heading" }, name: { value: "Sign in" }, properties: [{ name: "level", value: { value: 1 } }], backendDOMNodeId: 3 },
  { nodeId: "4", role: { value: "link" }, name: { value: "Forgot password?" }, properties: [{ name: "focusable", value: { value: true } }], backendDOMNodeId: 4 },
  { nodeId: "5", role: { value: "StaticText" }, name: { value: "Use your account" }, backendDOMNodeId: 5 },
  { nodeId: "6", role: { value: "textbox" }, name: { value: "Email" }, value: { value: "a@b.c" }, properties: [{ name: "required", value: { value: true } }, { name: "focusable", value: { value: true } }], backendDOMNodeId: 6 },
  { nodeId: "7", role: { value: "checkbox" }, name: { value: "Remember me" }, properties: [{ name: "checked", value: { value: "true" } }], backendDOMNodeId: 7 },
  { nodeId: "8", role: { value: "navigation" }, name: { value: "Footer" }, childIds: ["9"], backendDOMNodeId: 8 },
  { nodeId: "9", role: { value: "link" }, name: { value: "Help" }, backendDOMNodeId: 9 },
];

test("interactiveOnly keeps actionables + headings + named landmarks, drops StaticText", () => {
  const r = formatAXTree(NODES, { interactiveOnly: true, refStart: 0 });
  assert.match(r.text, /heading "Sign in" \[level=1\]/);
  assert.match(r.text, /link "Forgot password\?" @e1/);
  assert.match(r.text, /textbox "Email" @e2 \[required\] = "a@b\.c"/);
  assert.match(r.text, /checkbox "Remember me" @e3 \[checked\]/);
  assert.match(r.text, /navigation "Footer"/);
  assert.match(r.text, / {2}link "Help" @e4/); // indented under the landmark
  assert.ok(!r.text.includes("Use your account"), "StaticText dropped in interactiveOnly");
  assert.ok(!r.text.toLowerCase().includes("generic"), "generic containers collapsed");
  assert.deepEqual(r.refs.map(([ref]) => ref), ["@e1", "@e2", "@e3", "@e4"]);
  assert.equal(r.nextRefIndex, 4);
});

test("full mode includes StaticText; refStart continues the per-tab counter", () => {
  const r = formatAXTree(NODES, { interactiveOnly: false, refStart: 10 });
  assert.match(r.text, /text "Use your account"/);
  assert.equal(r.refs[0][0], "@e11"); // never recycles earlier @eN strings
});

test("depth prunes below the limit; rootBackendNodeId scopes the subtree", () => {
  const shallow = formatAXTree(NODES, { interactiveOnly: true, depth: 1, refStart: 0 });
  assert.match(shallow.text, /navigation "Footer"/);
  assert.ok(!shallow.text.includes("Help"), "children beyond depth pruned");
  const scoped = formatAXTree(NODES, { interactiveOnly: true, rootBackendNodeId: 8, refStart: 0 });
  assert.match(scoped.text, /navigation "Footer"/);
  assert.match(scoped.text, /link "Help"/);
  assert.ok(!scoped.text.includes("Email"), "outside the scoped subtree");
});

test("snapshot text never contains markup", () => {
  const r = formatAXTree(NODES, { interactiveOnly: false, refStart: 0 });
  assert.ok(!/<[a-z]/i.test(r.text));
});

test("parseChord maps named keys, chars and modifier chords", () => {
  assert.deepEqual(parseChord("Enter"), { modifiers: 0, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  assert.deepEqual(parseChord("Shift+Tab"), { modifiers: 8, key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, text: "" });
  const ctrlA = parseChord("Control+a");
  assert.equal(ctrlA.modifiers, 2);
  assert.equal(ctrlA.windowsVirtualKeyCode, 65);
  assert.equal(ctrlA.text, "", "ctrl chords never insert text");
  const plain = parseChord("x");
  assert.equal(plain.text, "x");
  assert.equal(plain.code, "KeyX");
  assert.throws(() => parseChord("Hyper+z"), /unknown modifier/);
  assert.throws(() => parseChord("NotAKey"), /unknown key/);
});
