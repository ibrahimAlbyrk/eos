import { memo, useState } from "react";
import { Icon, Avatar } from "./primitives.jsx";

export const PendingBanner = memo(function PendingBanner({ pending, agents, onApprove, onDeny }) {
  if (!pending || pending.length === 0) return null;
  const p = pending[0];
  const agent = agents.find(a => a.id === p.worker_id);
  const expiresSec = Math.max(0, Math.round((p.expires_at - Date.now()) / 1000));
  let brief = p.input;
  try { const j = JSON.parse(p.input); brief = j.file_path || j.command || j.url || JSON.stringify(j).slice(0, 80); } catch {}
  return (
    <div className="vb-pendbar">
      <div className="vb-pendbar__icon">
        <Icon name="shield" size={14} />
      </div>
      <div className="vb-pendbar__main">
        <div className="vb-pendbar__title">
          <b>{agent?.name || p.worker_id}</b> wants to use <code className="vb-inlinecode">{p.tool_name}</code> on <code className="vb-inlinecode">{String(brief).slice(0, 60)}</code>
        </div>
        <div className="vb-pendbar__sub">
          {pending.length > 1
            ? <span>+{pending.length - 1} more queued · approve to apply this change</span>
            : <span>approve to apply this change, deny to block it</span>}
        </div>
      </div>
      <div className="vb-pendbar__timer">
        <Icon name="clock" size={12} />
        <span>auto-deny in <b>{expiresSec}s</b></span>
      </div>
      <div className="vb-pendbar__actions">
        <button className="vb-btn vb-btn--pendbar-ghost" onClick={() => onDeny(p.id)}>Deny</button>
        <button className="vb-btn vb-btn--pendbar-primary" onClick={() => onApprove(p.id)}>
          <Icon name="check" size={12} /> Approve
        </button>
      </div>
    </div>
  );
});

const PendingCard = memo(function PendingCard({ p, agents, onApprove, onDeny }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(() => {
    try { return JSON.stringify(JSON.parse(p.input), null, 2); } catch { return p.input; }
  });
  const [err, setErr] = useState(null);
  const agent = agents.find(a => a.id === p.worker_id);
  const expiresSec = Math.max(0, Math.round((p.expires_at - Date.now()) / 1000));
  let brief = p.input;
  try { const j = JSON.parse(p.input); brief = j.file_path || j.command || j.url || JSON.stringify(j).slice(0, 80); } catch {}

  const approveWithEdit = async () => {
    setErr(null);
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { setErr("invalid JSON: " + e.message); return; }
    await onApprove(p.id, parsed);
  };

  return (
    <div className="vb-pending-card">
      <div className="vb-pending-card__head">
        <div className="vb-pending-card__left">
          {agent && <Avatar agent={agent} size={32} />}
          <div>
            <div className="vb-pending-card__title">{agent?.name || p.worker_id} wants to use <code className="vb-inlinecode">{p.tool_name}</code></div>
            <div className="vb-pending-card__sub">{String(brief).slice(0, 200)}</div>
          </div>
        </div>
        <div className="vb-pending-card__timer">
          <Icon name="clock" size={12} />
          <span>{expiresSec}s</span>
        </div>
      </div>
      {editing ? (
        <textarea className="vb-pending-card__editor" value={text} onChange={e => setText(e.target.value)} rows={Math.min(20, text.split("\n").length + 1)} />
      ) : (
        <pre className="vb-code vb-pending-card__code">{text}</pre>
      )}
      {err && <div className="vb-modal__err" style={{ margin: "0 0 8px" }}>{err}</div>}
      <div className="vb-pending-card__actions">
        <button className="vb-btn vb-btn--ghost" onClick={() => setEditing(v => !v)}>
          {editing ? "Cancel edit" : "Edit input"}
        </button>
        <div className="vb-pending-card__actions-right">
          <button className="vb-btn" onClick={() => onDeny(p.id)}>Deny</button>
          {editing
            ? <button className="vb-btn vb-btn--primary" onClick={approveWithEdit}><Icon name="check" size={12} /> Approve with edits</button>
            : <button className="vb-btn vb-btn--primary" onClick={() => onApprove(p.id)}><Icon name="check" size={12} /> Approve</button>
          }
        </div>
      </div>
    </div>
  );
});

export const PendingPane = memo(function PendingPane({ pending, agents, onApprove, onDeny }) {
  if (pending.length === 0) {
    return <div className="vb-empty"><Icon name="check" size={32} /><div>Nothing pending</div></div>;
  }
  return (
    <div className="vb-feed">
      <div className="vb-feed__inner">
        {pending.map(p => (
          <PendingCard key={p.id} p={p} agents={agents} onApprove={onApprove} onDeny={onDeny} />
        ))}
      </div>
    </div>
  );
});
