import { memo, useMemo } from "react";
import { renderMarkdown } from "../../lib/markdown.js";
import { ToolShell } from "./ToolShell.jsx";
import { resultStatus } from "./shared.js";

export const PlanTool = memo(function PlanTool({ tool, result, family }) {
  const plan = tool.input?.plan || "";
  const html = useMemo(() => renderMarkdown(plan), [plan]);
  const status = resultStatus(result);

  return (
    <ToolShell
      family={family}
      icon="scroll"
      title={<span className="vb-tool__name"><span className="vb-tool__verb">Plan</span><span className="vb-tool__arr">›</span><span className="vb-plan__sub">submitted</span></span>}
      subtitle={<span className="vb-plan__hint">awaiting human review</span>}
      status={status}
      defaultOpen
      body={
        <div className="vb-toolbody vb-toolbody--plan">
          <div className="vb-plan__scroll">
            <div className="vb-plan__edge vb-plan__edge--top" />
            <div className="vb-plan__paper vb-md" dangerouslySetInnerHTML={{ __html: html }} />
            <div className="vb-plan__edge vb-plan__edge--bot" />
          </div>
        </div>
      }
    />
  );
});
