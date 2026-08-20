import { useUi } from "../../../state/ui.jsx";
import { explorer, useExplorerRoot, useExpanded } from "../../../state/explorerStore.js";
import { baseName } from "../../../lib/explorerApi.js";

const ICON = {
  newFile: "M8.5 2H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6.5L8.5 2Z M8.5 2v4.5H13 M8 8.5v3M6.5 10h3",
  newFolder: "M2 4.4a1 1 0 0 1 1-1h2.8l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z M8 7v3M6.5 8.5h3",
  collapse: "M4 6l4-3 4 3 M4 10l4 3 4-3",
  expand: "M4 3l4 3 4-3 M4 13l4-3 4 3",
};

function TbBtn({ d, title, onClick, two, active }) {
  return (
    <button className={"fx-tb-btn" + (active ? " on" : "")} title={title} aria-label={title} onClick={onClick}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {two ? d.split(" M").map((seg, i) => <path key={i} d={(i ? "M" : "") + seg} />) : <path d={d} />}
      </svg>
    </button>
  );
}

export function ExplorerToolbar() {
  const ui = useUi();
  const root = useExplorerRoot();
  const expanded = useExpanded();
  const anyExpanded = expanded.size > 0;
  const pickerOpen = ui.openPopover === "fx-folder";

  const togglePicker = (e) => {
    if (pickerOpen) { ui.closeAllPops(); return; }
    const bar = e.currentTarget.parentElement.getBoundingClientRect();
    ui.openPop("fx-folder", { x: bar.left, y: bar.bottom + 4, data: { width: bar.width } });
  };

  return (
    <div className="fx-toolbar">
      <button
        className="fx-root-chip"
        data-popover-trigger="fx-folder"
        title={root ?? "Open a folder"}
        onClick={togglePicker}
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 4.4a1 1 0 0 1 1-1h2.8l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z" />
        </svg>
        <span className="fx-root-name">{root ? baseName(root) : "Open folder"}</span>
        <svg className="fx-root-chev" width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m4 6 4 4 4-4" /></svg>
      </button>

      <div className="fx-tb-actions">
        <TbBtn two d={ICON.newFile} title="New File" onClick={() => root && explorer.startDraft(root, "file")} />
        <TbBtn two d={ICON.newFolder} title="New Folder" onClick={() => root && explorer.startDraft(root, "directory")} />
        <TbBtn
          two
          d={anyExpanded ? ICON.collapse : ICON.expand}
          title={anyExpanded ? "Collapse all" : "Expand all"}
          onClick={() => (anyExpanded ? explorer.collapseAll() : explorer.expandAll())}
        />
      </div>
    </div>
  );
}
