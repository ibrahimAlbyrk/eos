import { useEffect, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";

export function QuickPromptModal({ live }) {
  const ui = useUi();
  const [text, setText] = useState("");
  const ref = useRef(null);

  useEffect(() => {
    if (ui.openPopover === "quick-prompt") {
      setText("");
      setTimeout(() => ref.current?.focus(), 30);
    }
  }, [ui.openPopover]);

  if (ui.openPopover !== "quick-prompt") return null;
  const { agentId, name, model } = ui.popoverData;

  const submit = async () => {
    const t = text.trim();
    if (!t || !agentId) { ui.closeAllPops(); return; }
    await live.sendToAgent(agentId, t);
    ui.closeAllPops();
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="qp-overlay open" id="qpOverlay" onClick={(e) => { if (e.target === e.currentTarget) ui.closeAllPops(); }} data-popover="quick-prompt">
      <div className="qp-modal glass-pop" onClick={(e) => e.stopPropagation()}>
        <div className="qp-modal__head">
          <span className="qp-modal__arrow">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M3 8h9M9 4l4 4-4 4" />
            </svg>
          </span>
          <span className="qp-modal__name">{name}</span>
          <span className="qp-modal__model">{model}</span>
          <button className="qp-modal__close" onClick={ui.closeAllPops} title="Close">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="qp-modal__body">
          <textarea
            ref={ref}
            rows="4"
            placeholder={`Tell ${name} what to do…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
        </div>
        <div className="qp-modal__foot">
          <div className="qp-modal__hints">
            <span><kbd>⏎</kbd>send</span>
            <span><kbd>⇧⏎</kbd>newline</span>
            <span><kbd>Esc</kbd>cancel</span>
          </div>
          <button className="qp-modal__send" onClick={submit}>
            Send
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M3 8h9M9 4l4 4-4 4" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
