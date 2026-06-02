import { ToolItem } from "./ToolItem.jsx";

export function ToolGroup({ summary, tools, open, onToggle, cwd }) {
  return (
    <div className={"tool-group" + (open ? " open" : "")}>
      <div className="tool-group-header" onClick={onToggle}>
        <span className="tg-summary">{summary}</span>
        <svg className="tg-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </div>
      {open && (
        <div className="tool-group-list">
          {tools.map((t, i) => (
            <ToolItem key={t.id ?? i} tool={t} cwd={cwd} />
          ))}
        </div>
      )}
    </div>
  );
}
