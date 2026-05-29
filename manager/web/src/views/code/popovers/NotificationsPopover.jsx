import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";

const TRIGGERS = [
  { id: "agent_finished",     label: "Agent finished",     desc: "An agent completes its turn" },
  { id: "agent_exited",       label: "Agent exited",       desc: "An agent process stops" },
  { id: "permission_pending", label: "Permission pending", desc: "A worker is waiting for approval" },
  { id: "permission_expired", label: "Permission expired", desc: "A pending request timed out" },
];

export function NotificationsPopover() {
  const ui = useUi();
  const open = ui.openPopover === "notifications";
  const [config, setConfig] = useState(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.getNotificationConfig()
      .then((c) => { if (!cancelled) setConfig(c); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;
  const { x, y } = ui.popoverPos;
  const left = Math.min(x, window.innerWidth - 300);
  const top = Math.min(y, window.innerHeight - 360);

  const persist = (next) => {
    setConfig(next);
    api.setNotificationConfig(next).catch(() => {});
  };

  const toggleAll = () => {
    if (!config) return;
    persist({ ...config, enabled: !config.enabled });
  };

  const toggleTrigger = (id) => {
    if (!config) return;
    const rule = config.rules[id];
    persist({ ...config, rules: { ...config.rules, [id]: { ...rule, enabled: !rule.enabled } } });
  };

  const setCooldown = (id, seconds) => {
    if (!config) return;
    const ms = Math.max(0, Math.round(seconds * 1000));
    const rule = config.rules[id];
    persist({ ...config, rules: { ...config.rules, [id]: { ...rule, cooldownMs: ms } } });
  };

  return (
    <div
      className="ctx-menu glass-pop open"
      id="notificationsPopover"
      data-popover="notifications"
      style={{ display: "block", left, top, width: 288 }}
    >
      <div className="menu-head"><b>Notifications</b></div>

      <button className={"ap-option" + (config?.enabled ? " on" : "")} onClick={toggleAll} disabled={!config}>
        <span className={"cb-worktree-check" + (config?.enabled ? " on" : "")} aria-hidden="true"
              style={config?.enabled ? { background: "var(--accent)", borderColor: "var(--accent)", color: "#0a0a0a" } : null}>
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m3 8 3 3 7-7" />
          </svg>
        </span>
        <div className="ap-text">
          <div className="ap-label">Enable notifications</div>
          <div className="ap-desc">Master switch for all triggers</div>
        </div>
      </button>

      <div className="menu-sep"></div>

      {TRIGGERS.map((t) => {
        const rule = config?.rules?.[t.id];
        const on = Boolean(rule?.enabled);
        return (
          <div key={t.id}>
            <button
              className={"ap-option" + (on ? " on" : "")}
              onClick={() => toggleTrigger(t.id)}
              disabled={!config}
            >
              <span className="cb-worktree-check" aria-hidden="true"
                    style={on ? { background: "var(--accent)", borderColor: "var(--accent)", color: "#0a0a0a" } : null}>
                <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m3 8 3 3 7-7" />
                </svg>
              </span>
              <div className="ap-text">
                <div className="ap-label">{t.label}</div>
                <div className="ap-desc">{t.desc}</div>
              </div>
            </button>
            <label className="ap-desc" style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 11px 6px 33px" }}>
              Cooldown
              <input
                type="number"
                min="0"
                step="1"
                value={rule ? rule.cooldownMs / 1000 : 0}
                disabled={!config}
                onChange={(e) => setCooldown(t.id, Number(e.target.value))}
                style={{
                  width: 54,
                  padding: "3px 6px",
                  borderRadius: 5,
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.10)",
                  color: "var(--fg)",
                  fontSize: "11px",
                }}
              />
              s
            </label>
          </div>
        );
      })}
    </div>
  );
}
