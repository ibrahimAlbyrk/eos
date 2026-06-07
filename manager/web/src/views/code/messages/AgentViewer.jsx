import { useCallback, useEffect, useRef } from "react";
import { useUi } from "../../../state/ui.jsx";
import { MarkdownView } from "./MarkdownView.jsx";
import { ToolItem } from "./ToolItem.jsx";
import { verbFor } from "../../../lib/messageParser.js";

export function AgentViewer() {
  const ui = useUi();
  const open = !!ui.agentViewer;
  return (
    <div className={"agent-viewer" + (open ? " av-open" : "")}>
      {open && <AgentViewerInner block={ui.agentViewer} />}
    </div>
  );
}

function AgentViewerInner({ block }) {
  const ui = useUi();
  const scrollRef = useRef(null);
  const isNearBottomRef = useRef(true);
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

  const checkNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", checkNearBottom, { passive: true });
    return () => el.removeEventListener("scroll", checkNearBottom);
  }, [checkNearBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isNearBottomRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [tools.length, block.result]);

  return (
    <>
      <div className="av-header">
        <span className="av-title">{block.description || "Agent"}</span>
        <button className="av-close" onClick={ui.closeAgentViewer} title="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      <div className="av-scroll" ref={scrollRef}>
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
    </>
  );
}
