import { describe, it, expect, vi, beforeAll } from "vitest";
import { shareBlocks } from "../../../lib/shareBlocks.js";

// Row bodies are stubs that count their renders (keyed by what they show); the
// memoized TranscriptRow around them is the real one.
const renders = new Map();
const count = (k) => renders.set(k, (renders.get(k) ?? 0) + 1);
vi.mock("./MessageRow.jsx", () => ({ MessageRow: ({ copyText }) => { count(copyText); return <div className="msg-row">{copyText}</div>; } }));
vi.mock("./ToolGroup.jsx", () => ({ ToolGroup: ({ summary }) => { count(summary); return <div className="tool-group">{summary}</div>; } }));

// No jsdom here: just enough of a DOM for react-dom to mount and update a tree.
class Node {
  constructor(nodeType, nodeName, doc) { this.nodeType = nodeType; this.nodeName = nodeName; this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get nextSibling() { const s = this.parentNode?.childNodes; return s ? s[s.indexOf(this) + 1] ?? null : null; }
  appendChild(c) { c.parentNode?.removeChild(c); this.childNodes.push(c); c.parentNode = this; return c; }
  insertBefore(c, ref) {
    if (!ref) return this.appendChild(c);
    c.parentNode?.removeChild(c);
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
  addEventListener() {}
  removeEventListener() {}
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.childNodes = []; if (v) this.appendChild(this.ownerDocument.createTextNode(v)); }
}
class Text extends Node {
  constructor(t, doc) { super(3, "#text", doc); this.nodeValue = t; }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = v; }
}
class Element extends Node {
  constructor(tag, doc) { super(1, tag.toUpperCase(), doc); this.tagName = tag.toUpperCase(); this.attributes = {}; this.style = {}; this.namespaceURI = "http://www.w3.org/1999/xhtml"; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  removeAttribute(k) { delete this.attributes[k]; }
}

let React, createRoot, TranscriptRow, sameWorkerIdentities;
beforeAll(async () => {
  const doc = new Node(9, "#document", null);
  Object.assign(doc, {
    createElement: (t) => new Element(t, doc),
    createElementNS: (_ns, t) => new Element(t, doc),
    createTextNode: (t) => new Text(t, doc),
    defaultView: globalThis,
  });
  globalThis.document = doc;
  globalThis.window ??= globalThis;
  globalThis.HTMLIFrameElement ??= class {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ TranscriptRow, sameWorkerIdentities } = await import("./Messages.jsx"));
}, 60_000);

const keyOf = (b, i) => b.kind + "-" + (b.rowId ?? i);
const parse = (rows) => rows.map((r) => structuredClone(r));
const toggle = () => {};

// What Messages' renderRow hands each row, for the kinds below.
function Rows({ blocks, workers }) {
  return (
    <div className="messages">
      {blocks.map((b, i) => {
        const key = keyOf(b, i);
        return (
          <TranscriptRow
            key={key} block={b} rowKey={key} sessionId="w1" cwd="/p"
            workers={b.kind === "report" || b.kind === "toolGroup" ? workers : undefined}
            canRewind={false} rewindOccurrence={0}
            groupOpen={b.kind === "toolGroup" ? false : undefined}
            onToggleTool={b.kind === "toolGroup" ? toggle : undefined}
          />
        );
      })}
    </div>
  );
}

const history = [
  { kind: "user", rowId: 1, text: "fix the build", ts: 1 },
  { kind: "toolGroup", rowId: 2, summary: "Read 1 file", tools: [{ id: "t1", name: "Read", input: { file_path: "/p/a" }, result: null, running: true }], ts: 2 },
  { kind: "report", rowId: 3, text: "child done", fromWorker: "w2", workerName: "child", ts: 3 },
  { kind: "assistant", rowId: 4, text: "working on it", ts: 4 },
];

describe("TranscriptRow", () => {
  it("re-renders only the new and changed rows when the transcript grows", async () => {
    const { act } = React;
    const el = document.createElement("div");
    const root = createRoot(el);
    let shown = null;
    const show = async (rows, workers) => {
      shown = shareBlocks(shown, parse(rows), keyOf);
      renders.clear();
      await act(async () => root.render(<Rows blocks={shown} workers={workers} />));
      return Object.fromEntries(renders);
    };
    const workers = [{ id: "w1", name: "me", state: "WORKING" }, { id: "w2", name: "child", state: "IDLE" }];

    expect(await show(history, workers)).toEqual({ "fix the build": 1, "Read 1 file": 1, "child done": 1, "working on it": 1 });

    // A new parse of the same rows plus one new reply: only the reply draws.
    const appended = [...history, { kind: "assistant", rowId: 5, text: "done", ts: 5 }];
    expect(await show(appended, workers)).toEqual({ done: 1 });

    // The running tool finishes: only its group draws again.
    const finished = parse(appended);
    finished[1].tools[0] = { ...finished[1].tools[0], running: false, result: { text: "ok" } };
    expect(await show(finished, workers)).toEqual({ "Read 1 file": 1 });

    // The parent draws again with nothing changed: no row does.
    expect(await show(finished, workers)).toEqual({});

    // A rename reaches the rows that read the worker list, and only those.
    const renamed = [workers[0], { ...workers[1], name: "renamed" }];
    expect(await show(finished, renamed)).toEqual({ "Read 1 file": 1, "child done": 1 });
    expect(el.textContent).toBe("fix the buildRead 1 filechild doneworking on itdone");

    await act(async () => root.unmount());
  });
});

describe("sameWorkerIdentities", () => {
  const a = [{ id: "w1", name: "me", is_orchestrator: true, state: "IDLE" }, { id: "w2", name: "child", worker_definition: "git", state: "WORKING" }];
  it("ignores what rows never read (state, tokens, …)", () => {
    expect(sameWorkerIdentities(a, a.map((w) => ({ ...w, state: "DONE", context_tokens: 5 })))).toBe(true);
  });
  it("sees a rename, a definition, the role, and a worker coming or going", () => {
    expect(sameWorkerIdentities(a, [a[0], { ...a[1], name: "x" }])).toBe(false);
    expect(sameWorkerIdentities(a, [a[0], { ...a[1], worker_definition: null }])).toBe(false);
    expect(sameWorkerIdentities(a, [{ ...a[0], is_orchestrator: false }, a[1]])).toBe(false);
    expect(sameWorkerIdentities(a, [a[0]])).toBe(false);
    expect(sameWorkerIdentities(a, [a[1], a[0]])).toBe(false);
    expect(sameWorkerIdentities(null, a)).toBe(false);
  });
});
