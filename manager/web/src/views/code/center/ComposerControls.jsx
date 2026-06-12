import { useEffect } from "react";
import { useUi } from "../../../state/ui.jsx";
import { contextUsage } from "../../../lib/contextWindow.js";
import { modelName, modelCtx, EFFORT_LABELS, effortChoicesFor } from "../../../lib/models.js";
import { AcceptPopover } from "../popovers/AcceptPopover.jsx";
import { AttachPopover } from "../popovers/AttachPopover.jsx";
import { ModelPopover } from "../popovers/ModelPopover.jsx";
import { EffortPopover } from "../popovers/EffortPopover.jsx";
import { CtxPopover } from "../popovers/CtxPopover.jsx";
import { GitAgentPopover } from "../popovers/GitAgentPopover.jsx";
import { TemplatePickerPopover } from "../popovers/TemplatePickerPopover.jsx";

const MODE_LABELS = {
  default: "Default",
  acceptEdits: "Accept edits",
  plan: "Plan only",
  bypassPermissions: "Bypass all",
};

export function ComposerControls({ live, onAttach, historyNav }) {
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
  const warn = Math.max(0, Math.min(1, (pct - 50) / 30));
  const ringColor = `color-mix(in srgb, var(--accent), #e8b94a ${Math.round(warn * 100)}%)`;

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
        <div className="git-wrap" style={{ position: "relative" }}>
          <button
            className={"iconbtn git-agent-btn" + (ui.composer.gitMode ? " on" : "")}
            title={ui.composer.gitMode ? "Exit git mode (⌘G)" : "Git agent (⌘G)"}
            onClick={(e) => {
              if (ui.composer.gitMode) {
                e.stopPropagation();
                ui.toggleGitMode(false);
                ui.closeAllPops();
                return;
              }
              toggle("git-agent", e);
            }}
            data-popover-trigger="git-agent"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="4.5" cy="3.5" r="1.5" />
              <circle cx="4.5" cy="12.5" r="1.5" />
              <circle cx="11.5" cy="5" r="1.5" />
              <path d="M4.5 5v6M11.5 6.5c0 2.2-2.7 2.6-4.5 3.2" />
            </svg>
          </button>
          <GitAgentPopover
            live={live}
            cwd={selected ? (selected.cwd ?? selected.worktree_from) : (ui.composer.cwd ?? live.recents[0] ?? null)}
          />
        </div>
        <div className="tpl-wrap" style={{ position: "relative" }}>
          <button
            className="iconbtn"
            title="Prompt templates"
            onClick={(e) => toggle("templates", e)}
            data-popover-trigger="templates"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z" />
              <path d="M9.5 1.5V4.5h3" />
              <path d="M6 8.5h4M6 11h2.5" />
            </svg>
          </button>
          <TemplatePickerPopover />
        </div>
        {historyNav && (
          <div className="history-badge">history {historyNav.pos}/{historyNav.total}</div>
        )}
      </div>
      <div className="grow"></div>
      <div className="right">
        <div className="model-wrap" style={{ position: "relative" }}>
          <button
            className={"model-pill" + (ui.openPopover === "model" ? " open" : "")}
            id="modelPill"
            onClick={(e) => toggle("model", e)}
            data-popover-trigger="model"
          >
            <span>{modelInfo.name}</span>
            {modelInfo.ctx && <span className="ctx">({modelInfo.ctx} context)</span>}
          </button>
          <ModelPopover live={live} />
        </div>
        {effortChoicesFor(model).length > 0 && (
          <div className="effort-wrap" style={{ position: "relative" }}>
            <button
              className={"effort-pill" + (effort === "ultracode" ? " ultra" : "") + (ui.openPopover === "effort" ? " open" : "")}
              onClick={(e) => toggle("effort", e)}
              data-popover-trigger="effort"
            >
              {EFFORT_LABELS[effort] ?? "Extra"}
            </button>
            <EffortPopover live={live} />
          </div>
        )}
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
              {pct > 0 && (
                <circle className="ring-fill" cx="9" cy="9" r="7" strokeDasharray={dashArray} style={{ stroke: ringColor }} />
              )}
            </svg>
          </button>
          <CtxPopover
            used={used}
            total={total}
            pct={pct}
            costUsd={selected ? (selected.cost_usd ?? 0) : null}
            totalCostUsd={live.workers.reduce((sum, w) => sum + (w.cost_usd ?? 0), 0)}
          />
        </div>
      </div>
    </div>
  );
}
