import { memo } from "react";
import { stripMcpPrefix, filePathFromToolInput } from "../../lib/format.js";
import { ToolShell, RawPane } from "./ToolShell.jsx";
import { resultStatus } from "./shared.js";

// Last-resort renderer. Two stacked panes (input + output) with copy buttons.
// Matches the original ToolCard shape so unknown / future tools degrade
// gracefully into a recognizable block.
export const GenericTool = memo(function GenericTool({ tool, result, family = "generic" }) {
  const argsPreview = (tool.args || "").replace(/\s+/g, " ");
  const filePath = filePathFromToolInput(tool.tool, tool.input);
  const status = resultStatus(result);
  const showInput = !!(tool.args && tool.args.trim());
  const showOutput = !!(result?.body && String(result.body).trim());
  const isError = result?.type === "error";

  return (
    <ToolShell
      family={family}
      icon="tool"
      title={<span className="vb-tool__name">{stripMcpPrefix(tool.tool)}</span>}
      subtitle={argsPreview}
      status={status}
      filePath={filePath}
      body={
        (showInput || showOutput) ? (
          <>
            {showInput && <RawPane label="input" text={tool.args} />}
            {showOutput && <RawPane label={isError ? "error" : "output"} text={result.body} />}
          </>
        ) : null
      }
    />
  );
});
