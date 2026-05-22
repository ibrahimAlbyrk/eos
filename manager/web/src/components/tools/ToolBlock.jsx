import { Component, memo } from "react";
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

// React render-phase errors can only be caught by an ErrorBoundary, not
// try/catch around JSX. Falls back to GenericTool when a per-family renderer
// crashes (schema drift, malformed input) so the rest of the feed survives.
class ToolErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { errored: false };
  }
  static getDerivedStateFromError() {
    return { errored: true };
  }
  componentDidUpdate(prev) {
    if (prev.tool !== this.props.tool || prev.result !== this.props.result) {
      if (this.state.errored) this.setState({ errored: false });
    }
  }
  render() {
    if (this.state.errored) {
      return <GenericTool tool={this.props.tool} result={this.props.result} family="generic" />;
    }
    return this.props.children;
  }
}

export const ToolBlock = memo(function ToolBlock({ tool, result }) {
  const family = toolFamily(tool.tool);
  const Renderer = RENDERERS[family] || GenericTool;
  return (
    <ToolErrorBoundary tool={tool} result={result}>
      <Renderer tool={tool} result={result} family={family} />
    </ToolErrorBoundary>
  );
});

// Orphan result block (tool_use never paired). Renders as a stand-alone
// tool shell with no input panel.
export { OrphanResult } from "./OrphanResult.jsx";
