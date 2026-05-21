import { memo } from "react";
import { toolFamily } from "../../lib/format.js";
import { ReadTool } from "./ReadTool.jsx";
import { WriteTool } from "./WriteTool.jsx";
import { EditTool } from "./EditTool.jsx";
import { BashTool } from "./BashTool.jsx";
import { SearchTool } from "./SearchTool.jsx";
import { ToolSearchTool } from "./ToolSearchTool.jsx";
import { WebTool } from "./WebTool.jsx";
import { TaskTool } from "./TaskTool.jsx";
import { OrchestratorTool } from "./OrchestratorTool.jsx";
import { TodoTool } from "./TodoTool.jsx";
import { PlanTool } from "./PlanTool.jsx";
import { GenericTool } from "./GenericTool.jsx";

const RENDERERS = {
  read: ReadTool,
  write: WriteTool,
  edit: EditTool,
  bash: BashTool,
  search: SearchTool,
  toolsearch: ToolSearchTool,
  web: WebTool,
  task: TaskTool,
  orch: OrchestratorTool,
  todo: TodoTool,
  plan: PlanTool,
  generic: GenericTool,
};

export const ToolBlock = memo(function ToolBlock({ tool, result }) {
  const family = toolFamily(tool.tool);
  const Renderer = RENDERERS[family] || GenericTool;
  try {
    return <Renderer tool={tool} result={result} family={family} />;
  } catch (e) {
    // Defensive: any per-tool renderer crash falls back to generic so the
    // feed keeps rendering. Useful when daemon serializes a shape we didn't
    // anticipate (older transcripts, schema drift).
    return <GenericTool tool={tool} result={result} family="generic" />;
  }
});

// Orphan result block (tool_use never paired). Renders as a stand-alone
// tool shell with no input panel.
export { OrphanResult } from "./OrphanResult.jsx";
