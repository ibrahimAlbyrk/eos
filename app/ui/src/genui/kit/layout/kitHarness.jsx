// Test harness for the kit: a spec's ui through the real runtime (ViewProvider)
// and renderer, to static markup. Imported by the kit's tests only.

import { renderToStaticMarkup } from "react-dom/server";
import { ViewProvider } from "../../runtime/ViewContext.jsx";
import { renderNodes } from "../../render.jsx";
import { _reset, setSelection, setViewState } from "../../runtime/viewStateStore.js";
import { parseMarkup } from "../../../../../../contracts/src/genui/markup.ts";

// A local key: state written here never schedules a PUT to the daemon.
export const TEST_VIEW = "local:kit-test";

export function renderView(spec, { ui, state = {}, selection = {}, streaming = false, host } = {}) {
  const src = ui ?? spec.ui;
  const nodes = parseMarkup(src).nodes;
  _reset();
  for (const [k, v] of Object.entries(state)) setViewState(TEST_VIEW, k, v);
  for (const [c, id] of Object.entries(selection)) setSelection(TEST_VIEW, c, id);
  return renderToStaticMarkup(
    <ViewProvider viewId={TEST_VIEW} spec={{ ...spec, ui: src }} nodes={nodes} streaming={streaming} host={host}>
      <div className="gv-body">{renderNodes(nodes)}</div>
    </ViewProvider>,
  );
}

// The text a screen reader / the eye gets, tags stripped and entities decoded.
export function textOf(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function count(html, needle) {
  return html.split(needle).length - 1;
}
