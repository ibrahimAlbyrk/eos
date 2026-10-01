import { useUi } from "../../../state/ui.jsx";
import { defaultGroupOpen } from "../../../settings/toolExpansion.js";
import { ToolItem } from "./ToolItem.jsx";
import { ToolGroup } from "./ToolGroup.jsx";

// A "tool" or "toolGroup" block drawn the way the transcript draws it, for
// tool lists that live outside it (a subagent's work in the side panel).
export function ToolBlock({ block, cwd, workers }) {
  const ui = useUi();
  if (block.kind === "tool") return <ToolItem tool={block.tool} standalone cwd={cwd} workers={workers} />;
  const groupKey = "g:" + (block.tools[0]?.id ?? block.ts);
  // expandedTools holds toggles against the settings-driven default (XOR)
  const open = defaultGroupOpen(block.tools, ui.settings) !== ui.expandedTools.has(groupKey);
  return (
    <ToolGroup summary={block.summary} tools={block.tools} cwd={cwd} workers={workers}
      open={open} onToggle={() => ui.toggleToolExpanded(groupKey)} />
  );
}
