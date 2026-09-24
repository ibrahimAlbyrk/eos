import { ToolItem } from "./ToolItem.jsx";
import { DisclosureRow } from "./DisclosureRow.jsx";
import { ToolIcon } from "./ToolIcon.jsx";
import { Collapse } from "./Collapse.jsx";

// "Read 3 files, ran 2 shell commands" → the counted phrases ("3 files",
// "2 shell commands") lifted to the brighter object tone.
function emphasizeCounts(summary) {
  return summary.split(/(\b\d+ [^,×]+)/).map((part, i) =>
    i % 2 === 1 ? <b key={i}>{part}</b> : part
  );
}

export function ToolGroup({ summary, tools, open, onToggle, cwd, workers }) {
  const running = tools.some((t) => t.running === true);
  return (
    <div className="tool-group">
      <DisclosureRow expanded={open} onToggle={onToggle} className="tool-group-header">
        <span className="ti-icon">
          <ToolIcon name={running ? "spin" : "stack"} className={running ? "ti-spin" : ""} />
        </span>
        <span className={"tg-summary" + (running ? " ti-shimmer" : "")}>{emphasizeCounts(summary)}</span>
        <span className="ti-meta">{tools.length} calls</span>
      </DisclosureRow>
      <Collapse open={open}>
        <div className="tool-group-list">
          {tools.map((t, i) => (
            <ToolItem key={t.id ?? i} tool={t} cwd={cwd} workers={workers} />
          ))}
        </div>
      </Collapse>
    </div>
  );
}
