import { useState, useMemo, useEffect } from "react";
import { AgentName } from "../../../lib/agentName.js";

function parseInput(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw;
}

export function PermissionBanner({ permissions, workers, onApprove, onAlwaysAllow, onDeny }) {
  const [busy, setBusy] = useState(false);

  const current = permissions?.[0];
  const total = permissions?.length ?? 0;

  useEffect(() => {
    if (!current) return;
    const handler = (e) => {
      if (e.metaKey && e.key === "Enter") {
        e.preventDefault();
        onApprove(current.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [current, onApprove]);

  const input = useMemo(() => parseInput(current?.input), [current?.input]);

  if (!current) return null;

  const worker = workers.find((w) => w.id === current.worker_id);
  const detail = input.command ?? input.file_path ?? input.path ?? input.query ?? input.regex ?? "";
  const stacked = Math.min(total - 1, 2);

  const handle = async (fn) => {
    setBusy(true);
    try { await fn(); } catch { /* ignore */ }
    setBusy(false);
  };

  return (
    <div className="perm-banner">
      <div className="perm-stack" style={{ "--stacked": stacked }}>
        {stacked >= 2 && <div className="perm-ghost perm-ghost-2" />}
        {stacked >= 1 && <div className="perm-ghost perm-ghost-1" />}
        <div className="perm-item perm-front">
          <div className="perm-header">
            <span className="perm-dot" />
            <span className="perm-title">
              Allow <strong>{worker ? <AgentName worker={worker} /> : current.worker_id}</strong> to run <strong>{current.tool_name}</strong>?
            </span>
            {total > 1 && <span className="perm-count">{total} pending</span>}
            <span className="perm-scope">project (local)</span>
          </div>
          {detail && <pre className="perm-detail">{detail}</pre>}
          <div className="perm-actions">
            <button className="perm-btn perm-deny" disabled={busy} onClick={() => handle(() => onDeny(current.id))}>
              Deny
            </button>
            <div className="perm-right">
              <button className="perm-btn perm-always" disabled={busy} onClick={() => handle(() => onAlwaysAllow(current.id, current.tool_name, current.worker_id))}>
                Always allow
              </button>
              <button className="perm-btn perm-allow" disabled={busy} onClick={() => handle(() => onApprove(current.id))}>
                Allow once <span className="perm-shortcut">⌘↵</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
