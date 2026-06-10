import { ToolItem } from "./ToolItem.jsx";
import { DisclosureRow } from "./DisclosureRow.jsx";

export function ToolGroup({ summary, tools, open, onToggle, cwd }) {
  return (
    <div className="tool-group">
      <DisclosureRow expanded={open} onToggle={onToggle} className="tool-group-header">
        <span className="tg-summary">{summary}</span>
      </DisclosureRow>
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
