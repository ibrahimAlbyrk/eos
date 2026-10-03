import { useUi } from "../../../state/ui.jsx";
import { getPage } from "../../../state/pagesStore.js";
import { pageTabId } from "../../../lib/panelTabs.js";

// Body of a page tool row (create/append/edit/tick): a way into the page the
// agent just touched, opened as a tab in this pane's side panel.

// The page a page-tool call acted on: its input id, or the id create_page
// returned.
export function pageToolId(t) {
  if (t.input?.id) return t.input.id;
  try {
    return JSON.parse(t.result?.text ?? "")?.id ?? null;
  } catch {
    return null;
  }
}

export function pageToolTitle(t) {
  const id = pageToolId(t);
  return t.input?.title || (id && getPage(id)?.title) || "a page";
}

export function PageToolDetail({ tool }) {
  const ui = useUi();
  const id = pageToolId(tool);
  if (tool.result?.isError) return <div className="pg-tooldetail pg-tooldetail--error">{tool.result.text}</div>;
  if (!id) return null;
  return (
    <div className="pg-tooldetail">
      <button type="button" className="pg-tooldetail__open" onClick={() => ui.openPanel(pageTabId(id))}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M4 2.5h5.2L12 5.3v8.2H4z" /><path d="M9 2.5v3h3M6 8.5h4M6 11h2.8" /></svg>
        Open page
      </button>
    </div>
  );
}
