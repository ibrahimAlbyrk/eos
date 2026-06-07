import { useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";

// Double-Esc rewind panel (Claude Code parity). Lists the user prompts on the
// agent's active transcript branch; Enter restores the conversation to before
// the selected message and places its text back in the composer. ⌘Enter also
// restores the code (file checkpoints), when Claude has them.
export function RewindPanel({ live }) {
  const ui = useUi();
  const workerId = ui.rewindPanel?.workerId ?? null;
  const [targets, setTargets] = useState(null);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState(null);
  const [rewinding, setRewinding] = useState(false);
  const listRef = useRef(null);

  const worker = live.workers.find((w) => w.id === workerId) ?? null;
  const busy = worker && (worker.state === "WORKING" || worker.state === "SPAWNING");

  useEffect(() => {
    if (!workerId) return;
    let cancelled = false;
    setTargets(null);
    setError(null);
    setRewinding(false);
    api.getRewindTargets(workerId).then((r) => {
      if (cancelled) return;
      if (r.ok && Array.isArray(r.body?.targets)) {
        setTargets(r.body.targets);
        setSel(Math.max(0, r.body.targets.length - 1));
      } else {
        setTargets([]);
        setError(r.body?.error || "couldn't load messages");
      }
    });
    return () => { cancelled = true; };
  }, [workerId]);

  const doRewind = async (mode) => {
    if (rewinding || busy || !targets) return;
    const t = targets[sel];
    if (!t) return;
    setRewinding(true);
    setError(null);
    const r = await api.rewindWorker(workerId, t.uuid, mode);
    if (r.ok && r.body?.ok) {
      ui.updateComposer({ pendingText: { content: r.body.display || r.body.text || "", ts: Date.now() } });
      ui.closeRewindPanel();
    } else {
      setRewinding(false);
      setError(r.body?.error || `rewind failed (${r.status})`);
    }
  };

  // Capture phase so the composer's own arrow/Enter/Escape handlers (history
  // recall, send) never fire while the panel is open.
  useEffect(() => {
    if (!workerId) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        ui.closeRewindPanel();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setSel((s) => Math.max(0, s - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setSel((s) => (targets ? Math.min(targets.length - 1, s + 1) : s));
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        doRewind(e.metaKey ? "both" : "conversation");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  useEffect(() => {
    listRef.current?.querySelector(".is-sel")?.scrollIntoView({ block: "nearest" });
  }, [sel, targets]);

  if (!workerId) return null;

  return (
    <div className="rw-overlay" onMouseDown={ui.closeRewindPanel}>
      <div className="rw-modal glass-pop" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="rw-head">
          <span className="rw-title">Rewind</span>
          <button className="rw-close" onClick={ui.closeRewindPanel} aria-label="Close">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
        <div className="rw-sub">Restore the conversation to a previous message</div>
        {busy && <div className="rw-note">Agent is busy — interrupt it before rewinding.</div>}
        {error && <div className="rw-err">{error}</div>}
        <div className="rw-list" ref={listRef}>
          {targets === null && <div className="rw-empty">Loading…</div>}
          {targets !== null && targets.length === 0 && !error && (
            <div className="rw-empty">No messages to rewind to</div>
          )}
          {(targets ?? []).map((t, i) => (
            <div
              key={t.uuid}
              className={i === sel ? "rw-item is-sel" : "rw-item"}
              onMouseEnter={() => setSel(i)}
              onClick={() => doRewind("conversation")}
            >
              {(t.display || t.text || "").split("\n", 1)[0]}
            </div>
          ))}
        </div>
        <div className="rw-foot">
          {rewinding ? (
            <span className="rw-status">Rewinding…</span>
          ) : (
            <>
              <span><kbd>↵</kbd> conversation</span>
              <span><kbd>⌘↵</kbd> code + conversation</span>
              <span><kbd>esc</kbd> close</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
