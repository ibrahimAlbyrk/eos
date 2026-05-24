import { useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { ToolDetail } from "./ToolDetail.jsx";

export function ToolItem({ tool, standalone }) {
  const [expanded, setExpanded] = useState(false);
  const ui = useUi();
  const label = itemLabel(tool);
  const hasPath = tool.name === "Read" && tool.input?.file_path;

  const onFileClick = (e) => {
    if (!hasPath) return;
    e.stopPropagation();
    ui.openFileViewer(tool.input.file_path);
  };

  return (
    <div className={"tool-item" + (standalone ? " standalone" : "") + (expanded ? " expanded" : "")}>
      <div className="tool-item-header" onClick={() => setExpanded((e) => !e)}>
        <span className="ti-verb">{label.verb}</span>
        {" "}
        <span className={"ti-file" + (hasPath ? " ti-link" : "")} onClick={onFileClick}>{label.file}</span>
        <svg className="ti-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="m6 4 4 4-4 4" />
        </svg>
      </div>
      {expanded && <ToolDetail tool={tool} />}
    </div>
  );
}

function itemLabel(tool) {
  const name = tool.name ?? "";
  if (name === "Read") {
    return { verb: "Read", file: fileName(tool.input?.file_path) };
  }
  if (name === "Bash") {
    const cmd = (tool.input?.command ?? "").slice(0, 60);
    return { verb: "Ran", file: cmd };
  }
  if (name === "Edit" || name === "Write") {
    return { verb: name, file: fileName(tool.input?.file_path) };
  }
  return { verb: "Used", file: name };
}

function fileName(p) {
  if (!p) return "";
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}
