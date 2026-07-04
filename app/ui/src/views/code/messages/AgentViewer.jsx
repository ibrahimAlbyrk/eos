import { useLayoutEffect } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useStickToBottom } from "../../../hooks/useStickToBottom.js";
import { MarkdownView } from "./MarkdownView.jsx";
import { ScrollHoldContext } from "./scrollHoldContext.js";
import { ToolItem } from "./ToolItem.jsx";
import { verbFor } from "../../../lib/messageParser.js";
import { PanelCloseButton } from "./PanelCloseButton.jsx";

export function AgentViewer() {
  const ui = useUi();
  const open = !!ui.agentViewer;
  return (
    <div className="agent-viewer av-open">
      {open && <AgentViewerInner block={ui.agentViewer} />}
    </div>
  );
}

function AgentViewerInner({ block }) {
  const ui = useUi();
  const stick = useStickToBottom({ threshold: 30 });
  useLayoutEffect(() => { stick.write(Infinity, { pin: true }); }, []);
  const isDone = block.status === "completed";

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
    <>
      <div className="av-header">
        <span className="av-title">{block.description || "Agent"}</span>
        <PanelCloseButton onClose={ui.closeAgentViewer} className="av-close" />
      </div>

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
        </div>
      </div>
      </ScrollHoldContext.Provider>
    </>
  );
}
