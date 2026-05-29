import { useEffect } from "react";
import { useUi } from "../../../state/ui.jsx";
import { contextUsage } from "../../../lib/contextWindow.js";
import { modelName, modelCtx, EFFORT_LABELS } from "../../../lib/models.js";
import { AcceptPopover } from "../popovers/AcceptPopover.jsx";
import { AttachPopover } from "../popovers/AttachPopover.jsx";
import { ModelPopover } from "../popovers/ModelPopover.jsx";
import { CtxPopover } from "../popovers/CtxPopover.jsx";
import { NotificationsPopover } from "../popovers/NotificationsPopover.jsx";

const MODE_LABELS = {
  default: "Default",
  acceptEdits: "Accept edits",
  plan: "Plan only",
  bypassPermissions: "Bypass all",
};

export function ComposerControls({ live, onAttach }) {
  const ui = useUi();
  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;

  const mode = selected?.permission_mode ?? ui.composer.permissionMode;
  const model = selected?.model ?? ui.composer.model;
  const effort = selected?.effort ?? ui.composer.effort;
  const modelInfo = { name: modelName(model) || model || "—", ctx: modelCtx(model) || "" };

  useEffect(() => { live.updateLastUsage(selected?.id ?? null); }, [selected?.id]);
  useEffect(() => {
    if (selected) live.refreshLastUsage(selected.id);
  }, [selected?.tokens_in, selected?.tokens_out]);

  const { used, total, pct } = contextUsage(selected, model, live.lastUsage);
  const r = 7;
  const C = 2 * Math.PI * r;
  const filled = (pct / 100) * C;
  const dashArray = `${filled.toFixed(2)} ${(C - filled).toFixed(2)}`;

  const toggle = (id, e) => {
    e.stopPropagation();
    if (ui.openPopover === id) ui.closeAllPops();
    else ui.openPop(id);
  };

  return (
    <div className="c-row3">
      <div className="left">
        <div className="accept-wrap" style={{ position: "relative" }}>
          <button
            className="mode-pill"
            onClick={(e) => toggle("accept", e)}
            data-popover-trigger="accept"
          >
            {MODE_LABELS[mode] ?? "Accept edits"}
          </button>
          <AcceptPopover live={live} />
        </div>
        <div className="plus-wrap" style={{ position: "relative" }}>
          <button
            className="iconbtn"
            title="Attach"
            onClick={(e) => toggle("attach", e)}
            data-popover-trigger="attach"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
          <AttachPopover onAttach={onAttach} />
        </div>
      </div>
      <div className="grow"></div>
      <div className="right">
        <div className="model-wrap" style={{ position: "relative" }}>
          <button
            className="model-pill"
            id="modelPill"
            onClick={(e) => toggle("model", e)}
            data-popover-trigger="model"
          >
            <span>{modelInfo.name}</span>
            {modelInfo.ctx && <span className="ctx">{modelInfo.ctx}</span>}
            <span className="sub">·</span>
            <span className="effort">{EFFORT_LABELS[effort] ?? "High"}</span>
          </button>
          <ModelPopover live={live} />
        </div>
        <div className="notif-wrap" style={{ position: "relative" }}>
          <button
            className="iconbtn"
            title="Notifications"
            onClick={(e) => {
              e.stopPropagation();
              if (ui.openPopover === "notifications") { ui.closeAllPops(); return; }
              const rect = e.currentTarget.getBoundingClientRect();
              ui.openPop("notifications", { x: rect.left, y: rect.bottom + 6 });
            }}
            data-popover-trigger="notifications"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M8 2a3.5 3.5 0 0 0-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 0 0 8 2Z" />
              <path d="M6.8 13.5a1.3 1.3 0 0 0 2.4 0" />
            </svg>
          </button>
          <NotificationsPopover />
        </div>
        <div className="ctx-ring-wrap">
          <button
            className="ctx-ring-btn"
            id="ctxRingBtn"
            onClick={(e) => toggle("ctx", e)}
            title="Context usage"
            data-popover-trigger="ctx"
          >
            <svg viewBox="0 0 18 18" aria-hidden="true">
              <circle className="ring-track" cx="9" cy="9" r="7" />
              <circle className="ring-fill" cx="9" cy="9" r="7" strokeDasharray={dashArray} />
            </svg>
          </button>
          <CtxPopover used={used} total={total} pct={pct} session={live.session} />
        </div>
      </div>
    </div>
  );
}
