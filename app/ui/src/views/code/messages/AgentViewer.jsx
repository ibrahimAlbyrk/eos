import { useLayoutEffect } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useStickToBottom } from "../../../hooks/useStickToBottom.js";
import { MarkdownView } from "./MarkdownView.jsx";
import { ScrollHoldContext } from "./scrollHoldContext.js";
import { ToolItem } from "./ToolItem.jsx";
import { verbFor } from "../../../lib/messageParser.js";
import { PanelShell } from "../panes/PanelShell.jsx";

export function AgentViewer() {
  const ui = useUi();
  if (!ui.agentViewer) return <PanelShell type="agent" />;
  return <AgentViewerInner block={ui.agentViewer} />;
}

function AgentViewerInner({ block }) {
  const stick = useStickToBottom({ threshold: 30 });
  useLayoutEffect(() => { stick.write(Infinity, { pin: true }); }, []);
  const isDone = block.status !== "running";

  const tools = (block.tools || []).map((t) => ({
    id: t.id,
    name: t.name ?? "unknown",
    verb: verbFor(t.name),
    input: t.input ?? {},
    result: t.result ?? (t.done || isDone ? { text: "", isError: false } : null),
    running: t.running === true && !isDone,
    ts: t.ts,
  }));

  return (
    <PanelShell type="agent" title={block.description || "Agent"}>
      <ScrollHoldContext.Provider value={stick.hold}>
      <div className="av-scroll" ref={stick.scrollerRef}>
        <div ref={stick.contentRef}>
          {block.prompt && (
            <div className="av-prompt-bubble">{block.prompt}</div>
          )}

          {tools.length > 0 && (
            <div className="av-tools">
              {tools.map((t) => (
                <ToolItem key={t.id} tool={t} standalone />
              ))}
            </div>
          )}

          {block.result && (
            <div className="av-output-bubble">
              <MarkdownView content={block.result.replace(/<usage>[\s\S]*?<\/usage>\s*/g, "").trim()} />
            </div>
          )}

          {!isDone && tools.length === 0 && !block.result && (
            <div className="av-running-hint">Agent is running...</div>
          )}

          {isDone && block.background && !block.result && (
            <div className="av-running-hint">No output captured.</div>
          )}
        </div>
      </div>
      </ScrollHoldContext.Provider>
    </PanelShell>
  );
}
