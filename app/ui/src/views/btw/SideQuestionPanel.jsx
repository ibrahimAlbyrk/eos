import { useEffect, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { findLeaf } from "../../lib/paneLayout.js";
import { backendCaps } from "../../lib/backendCaps.js";
import { sideQuestionQuote } from "../../lib/sideQuestion.js";
import { askSideQuestion, useSideQuestion } from "../../state/sideQuestionStore.js";
import { pushTextHandoff } from "../../state/browserComposerHandoff.js";
import { PanelShell } from "../agents/panes/PanelShell.jsx";
import { MessageAssistant } from "../agents/messages/MessageAssistant.jsx";
import { Sheen } from "../agents/messages/Sheen.jsx";
import { usePathLinks } from "../agents/messages/paths/usePathLinks.jsx";
import { useArtifactLinks } from "../artifacts/useArtifactLinks.jsx";
import { joinHandlers } from "../../lib/joinHandlers.js";

// Side-panel tab: the /btw side question for this pane's agent — the question,
// its read-only answer from the agent's live conversation, and a field to ask
// another. One at a time; nothing here enters the conversation unless "Add to
// chat" puts it in the composer. ⌘/ opens it focused (panelData.btw.focus).
// Plan: docs/btw/00-BTW-PLAN.md.
export function SideQuestionPanel({ live }) {
  const ui = useUi();
  // In a split each pane asks its own agent; the global selection only stands
  // in until the pane tree has caught up with it.
  const workerId = findLeaf(ui.tree, ui.paneId)?.agentId ?? ui.selectedId ?? null;
  const worker = live.workers.find((w) => w.id === workerId) ?? null;
  const supported = Boolean(worker) && backendCaps(worker.backend_kind).sideQuestion === true;
  const entry = useSideQuestion(workerId);
  const [draft, setDraft] = useState("");
  const [copied, setCopied] = useState(false);
  const inputRef = useRef(null);
  const focusAt = ui.panelData?.btw?.focus ?? null;
  const pathLinks = usePathLinks({ cwd: worker?.cwd ?? null });
  const artifactLinks = useArtifactLinks();

  useEffect(() => { if (focusAt) inputRef.current?.focus(); }, [focusAt]);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const submit = (e) => {
    e.preventDefault();
    if (!supported || !draft.trim()) return;
    askSideQuestion(workerId, draft);
    setDraft("");
  };
  const addToChat = () => pushTextHandoff(ui.paneId, sideQuestionQuote(entry.question, entry.answer));
  const copy = () => navigator.clipboard?.writeText(entry.answer).then(() => setCopied(true), () => {});

  return (
    <PanelShell type="btw">
      <div className="btw__body">
        {entry ? (
          <>
            <p className="btw__question">{entry.question}</p>
            {entry.status === "asking" && <div className="btw__status ti-sheen-host">Thinking…<Sheen>Thinking…</Sheen></div>}
            {entry.status === "error" && (
              <div className="btw__error" role="alert">
                <span>{entry.error}</span>
                {supported && (
                  <button type="button" className="btw__retry" onClick={() => askSideQuestion(workerId, entry.question)}>Try again</button>
                )}
              </div>
            )}
            {entry.status === "done" && (
              <>
                <div className="btw__answer" {...joinHandlers(pathLinks.handlers, artifactLinks.handlers)}>
                  <MessageAssistant text={entry.answer} cwd={worker?.cwd ?? null} />
                  {pathLinks.layer}
                  {artifactLinks.layer}
                </div>
                <div className="btw__actions">
                  <button type="button" className="btw__add" onClick={addToChat}>
                    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 6.5 2.5 10 6 13.5" /><path d="M13.5 2.5v4.7a2.8 2.8 0 0 1-2.8 2.8H2.5" /></svg>
                    Add to chat
                  </button>
                  <button type="button" className="btw__icon-btn" onClick={copy} aria-label={copied ? "Copied" : "Copy answer"} title={copied ? "Copied" : "Copy answer"}>
                    {copied ? (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" /></svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" /></svg>
                    )}
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <div className="empty-state">
            <div className="empty-state__title">
              {!worker ? "No agent here" : supported ? "Ask on the side" : "Not available for this agent"}
            </div>
            <div className="empty-state__subtitle">
              {!worker
                ? "Pick a chat to ask about it."
                : supported
                  ? "A quick answer from this chat's context. It never enters the conversation, and the agent keeps working."
                  : "Side questions need a Claude agent."}
            </div>
          </div>
        )}
      </div>
      <form className="btw__foot" onSubmit={submit}>
        <div className="btw__field">
          <input
            ref={inputRef}
            className="btw__input"
            type="text"
            aria-label="Side question"
            placeholder="Ask on the side…"
            value={draft}
            disabled={!supported}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="btw__send" aria-label="Ask" disabled={!supported || !draft.trim()}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
          </button>
        </div>
        <p className="btw__hint">Read-only · sees this chat · answers once</p>
      </form>
    </PanelShell>
  );
}
