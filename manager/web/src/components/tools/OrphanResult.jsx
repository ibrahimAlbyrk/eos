import { memo } from "react";
import { ToolShell, RawPane } from "./ToolShell.jsx";

// Result event that never matched a tool_use (rare matcher miss). Same
// look as a regular tool block but with no input pane.
export const OrphanResult = memo(function OrphanResult({ result }) {
  const isError = result?.type === "error";
  const body = (result?.body || "").trim();
  if (!body) return null;
  return (
    <ToolShell
      family={isError ? "error" : "generic"}
      icon={isError ? "cross" : "check"}
      title={<span className="vb-tool__name">{isError ? "error" : "result"}</span>}
      status={{ tone: isError ? "err" : "ok", label: isError ? "err" : "ok" }}
      defaultOpen
      body={<RawPane label={isError ? "error" : "output"} text={body} />}
    />
  );
});
