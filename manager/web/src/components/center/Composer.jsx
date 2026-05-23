import { useEffect, useRef, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { ComposerConfigRow } from "./ComposerConfigRow.jsx";
import { ComposerDiffRow } from "./ComposerDiffRow.jsx";
import { ComposerControls } from "./ComposerControls.jsx";

export function Composer({ live }) {
  const ui = useUi();
  const [text, setText] = useState("");
  const textareaRef = useRef(null);

  const draft = ui.drafts.get(ui.selectedId);
  const isDraft = !!draft;
  const selected = !isDraft ? live.workers.find((w) => w.id === ui.selectedId) : null;

  const autoGrow = (el) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  useEffect(() => {
    if (textareaRef.current) autoGrow(textareaRef.current);
  }, [text]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    // Clear the textarea + add the optimistic bubble synchronously so the
    // UI feels instant. Reconciliation happens when the next /events poll
    // returns and the bubble's text matches a real user_message row.
    setText("");

    // Path 1 — draft selected: spawn the orchestrator from the draft's
    // composer settings, then swap selection to the real id and dispatch.
    if (isDraft) {
      const cwd = draft.cwd ?? live.recents[0] ?? null;
      if (!cwd) { alert("Pick a folder first."); return; }
      const draftId = ui.selectedId;
      const r = await live.spawnOrchestrator({
        name: draft.name || undefined,
        cwd,
        model: draft.model,
      });
      if (r?.ok && r.body?.id) {
        const realId = r.body.id;
        ui.removeDraft(draftId);
        ui.setSelectedId(realId);
        ui.addOptimisticUserMessage(realId, t);
        // Wait for the orchestrator to come online, then dispatch. We call
        // the API directly (not live.sendToAgent) because the setTimeout
        // closure captures a stale `live.workers` snapshot that doesn't yet
        // contain the just-spawned id, which would make the lookup 404.
        setTimeout(() => { api.sendOrchestratorMessage(realId, t); }, 1500);
      } else {
        // eslint-disable-next-line no-console
        console.error("spawn failed:", r);
        alert("Failed to create orchestrator.");
      }
      return;
    }

    // Path 2 — real orchestrator selected: just dispatch.
    if (selected) {
      ui.addOptimisticUserMessage(selected.id, t);
      try { await live.sendToAgent(selected.id, t); }
      catch (e) { /* eslint-disable-next-line no-console */ console.error("send failed:", e); }
      return;
    }

    // Path 3 — nothing selected: spawn orchestrator from the global composer
    // and dispatch. Same stale-closure caveat as Path 1.
    const cwd = ui.composer.cwd ?? live.recents[0] ?? null;
    if (!cwd) { alert("Pick a folder first."); return; }
    const r = await live.spawnOrchestrator({ cwd, model: ui.composer.model });
    if (r?.ok && r.body?.id) {
      const realId = r.body.id;
      ui.setSelectedId(realId);
      ui.addOptimisticUserMessage(realId, t);
      setTimeout(() => { api.sendOrchestratorMessage(realId, t); }, 1500);
    }
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer-inner">
        {selected ? (
          <ComposerDiffRow live={live} />
        ) : (
          <ComposerConfigRow live={live} />
        )}

        <div className="c-row2">
          <textarea
            ref={textareaRef}
            rows="1"
            placeholder="Type / for commands"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
          />
          <button className="submit" title="Send" onClick={send}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4v5H4m3-3l-3 3 3 3" />
            </svg>
          </button>
        </div>

        <ComposerControls live={live} />
      </div>
    </div>
  );
}
