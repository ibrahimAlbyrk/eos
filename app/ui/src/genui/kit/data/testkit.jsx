// Test support for Kit B (not imported by the app): render markup through the
// real renderer + runtime, or build a runtime whose state/selection writes can
// be observed without a DOM.

import { renderToStaticMarkup } from "react-dom/server";
import { parseMarkup } from "../../../../../../contracts/src/genui/markup.ts";
import { ViewProvider } from "../../runtime/ViewContext.jsx";
import { _resetSendLocks, createViewRuntime, scanMarkup } from "../../runtime/runtime.js";
import { setSelection, setViewState } from "../../runtime/viewStateStore.js";
import { renderNodes } from "../../render.jsx";

let seq = 0;

// Renders spec.ui through ViewProvider. A "local:" id keeps the state store
// off the network (no GET/PUT for a view that has no daemon id).
export function renderSpec(spec, { state = {}, selection = {} } = {}) {
  const viewId = `local:kitb-${++seq}`;
  for (const [k, v] of Object.entries(state)) setViewState(viewId, k, v);
  for (const [k, v] of Object.entries(selection)) setSelection(viewId, k, v);
  const nodes = parseMarkup(spec.ui ?? "").nodes;
  return renderToStaticMarkup(
    <ViewProvider viewId={viewId} spec={spec} nodes={nodes}>
      {renderNodes(nodes)}
    </ViewProvider>,
  );
}

// A runtime that rebuilds itself on every write, like the provider does.
export function testRuntime(spec, { state = {}, selection = {}, viewId = "v_kitbtest0001" } = {}) {
  // Each test runtime starts with no send lock or failure left by the last one.
  _resetSendLocks();
  const scan = scanMarkup(parseMarkup(spec.ui ?? "").nodes);
  const calls = [];
  const host = {
    send: async (text, opts) => {
      calls.push({ kind: "send", text, ...opts });
      return { ok: true };
    },
    prefill: (text) => calls.push({ kind: "prefill", text }),
    openUrl: (url) => calls.push({ kind: "openUrl", url }),
    openFile: (path) => calls.push({ kind: "openFile", path }),
    openExternal: (url) => calls.push({ kind: "openExternal", url }),
    copy: async (text) => calls.push({ kind: "copy", text }),
  };
  const box = { state: { ...state }, selection: { ...selection }, rt: null };
  const rebuild = () => {
    box.rt = createViewRuntime({
      viewId,
      viewTitle: spec.title ?? "",
      spec,
      scan,
      state: box.state,
      selection: box.selection,
      setState: (k, v) => {
        box.state = { ...box.state, [k]: v };
        rebuild();
      },
      select: (name, id) => {
        box.selection = { ...box.selection, [name]: id };
        rebuild();
      },
      host,
    });
  };
  rebuild();
  return {
    get view() {
      return box.rt;
    },
    get state() {
      return box.state;
    },
    get selection() {
      return box.selection;
    },
    calls,
  };
}

// Depth-first search through a React element tree (no rendering).
export function findElements(node, pred, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const n of node) findElements(n, pred, out);
    return out;
  }
  if (pred(node)) out.push(node);
  if (node.props && node.props.children !== undefined) findElements(node.props.children, pred, out);
  return out;
}
