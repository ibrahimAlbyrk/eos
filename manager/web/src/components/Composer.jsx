import { memo, useState, useEffect, useRef } from "react";
import { modelShort } from "../lib/format.js";
import { Icon } from "./primitives.jsx";

export const Composer = memo(function Composer({ target, busy, onSend, model, disabled, disabledReason }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [busySince, setBusySince] = useState(null);
  const [, tick] = useState(0);
  const ref = useRef(null);

  useEffect(() => { setBusySince(null); }, [target]);
  useEffect(() => {
    if (busy) setBusySince(cur => cur || Date.now());
    else setBusySince(null);
  }, [busy]);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const elapsedSec = busy && busySince ? Math.max(0, Math.floor((Date.now() - busySince) / 1000)) : 0;
  const elapsedLabel = elapsedSec < 60
    ? `${elapsedSec}s`
    : `${Math.floor(elapsedSec / 60)}m${String(elapsedSec % 60).padStart(2, "0")}s`;

  const submit = async () => {
    const v = text.trim();
    if (!v || sending || disabled) return;
    setSending(true);
    setText("");
    if (ref.current) ref.current.style.height = "auto";
    try { await onSend(v); } finally { setSending(false); }
  };

  const autoResize = (el) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  };

  return (
    <div className={`vb-composer ${busy ? "is-busy" : ""} ${disabled ? "is-disabled" : ""}`}>
      <div className="vb-composer__shell">
        <div className="vb-composer__header">
          <div className="vb-composer__target">
            <Icon name="arrowRight" size={12} />
            <span className="vb-composer__target-name">{target}</span>
          </div>
          <div className="vb-composer__chips">
            <span className="vb-chip">scope <b>full</b></span>
            <span className="vb-chip">policy <b>auto-spawn</b></span>
            <span className="vb-chip">model <b>{modelShort(model || "opus")}</b></span>
          </div>
          {busy && (
            <div className="vb-composer__thinking">
              <span className="vb-pulse-dot" />
              <span className="vb-mono">thinking {elapsedLabel}</span>
            </div>
          )}
        </div>
        <textarea
          ref={ref}
          placeholder={disabled ? (disabledReason || "No agent ready") : (sending ? "sending…" : `Tell ${target} what to do…`)}
          value={text}
          onChange={e => { setText(e.target.value); autoResize(e.target); }}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          rows={2}
          disabled={sending || disabled}
        />
        <div className="vb-composer__foot">
          <div className="vb-composer__hints">
            <span><kbd>⏎</kbd> send</span>
            <span><kbd>⇧⏎</kbd> newline</span>
          </div>
          <div className="vb-composer__foot-actions">
            <button className="vb-iconbtn" title="Attach (not implemented)" aria-label="Attach files" disabled><Icon name="folder" size={14} /></button>
            <button className="vb-iconbtn" title="History (not implemented)" aria-label="Message history" disabled><Icon name="history" size={14} /></button>
            <button className="vb-btn vb-btn--primary vb-btn--send" onClick={submit} disabled={!text.trim() || sending || disabled}>
              <span>{sending ? "Sending…" : "Send"}</span>
              <Icon name="send" size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});
