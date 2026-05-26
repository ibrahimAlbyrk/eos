import { useState, useMemo, useEffect, useCallback } from "react";

function parseInput(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw;
}

function PermissionItem({ perm, workers, onApprove, onAlwaysAllow, onDeny }) {
  const [busy, setBusy] = useState(false);
  const input = useMemo(() => parseInput(perm.input), [perm.input]);
  const worker = workers.find((w) => w.id === perm.worker_id);
  const label = worker?.name ?? perm.worker_id;

  const detail = input.command
    ?? input.file_path
    ?? input.path
    ?? input.query
    ?? input.regex
    ?? "";

  const handle = async (fn) => {
    setBusy(true);
    try { await fn(); } catch { /* ignore */ }
    setBusy(false);
  };

  return (
    <div className="perm-item">
      <div className="perm-header">
        <span className="perm-dot" />
        <span className="perm-title">
          Allow <strong>{label}</strong> to run <strong>{perm.tool_name}</strong>?
        </span>
        <span className="perm-scope">project (local)</span>
      </div>
      {detail && <pre className="perm-detail">{detail}</pre>}
      <div className="perm-actions">
        <button className="perm-btn perm-deny" disabled={busy} onClick={() => handle(() => onDeny(perm.id))}>
          Deny
        </button>
        <div className="perm-right">
          <button className="perm-btn perm-always" disabled={busy} onClick={() => handle(() => onAlwaysAllow(perm.id, perm.tool_name, perm.worker_id))}>
            Always allow
          </button>
          <button className="perm-btn perm-allow" disabled={busy} onClick={() => handle(() => onApprove(perm.id))}>
            Allow once <span className="perm-shortcut">⌘↵</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function PermissionBanner({ permissions, workers, onApprove, onAlwaysAllow, onDeny }) {
  useEffect(() => {
    if (!permissions || permissions.length === 0) return;
    const handler = (e) => {
      if (e.metaKey && e.key === "Enter") {
        e.preventDefault();
        onApprove(permissions[0].id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [permissions, onApprove]);

  if (!permissions || permissions.length === 0) return null;
  return (
    <div className="perm-banner">
      {permissions.map((p) => (
        <PermissionItem
          key={p.id}
          perm={p}
          workers={workers}
          onApprove={onApprove}
          onAlwaysAllow={onAlwaysAllow}
          onDeny={onDeny}
        />
      ))}
    </div>
  );
}
