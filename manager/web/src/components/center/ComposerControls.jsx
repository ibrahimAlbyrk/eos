import { useUi } from "../../state/ui.jsx";
import { contextUsage } from "../../lib/contextWindow.js";
import { AcceptPopover } from "../popovers/AcceptPopover.jsx";
import { AttachPopover } from "../popovers/AttachPopover.jsx";
import { ModelPopover } from "../popovers/ModelPopover.jsx";
import { CtxPopover } from "../popovers/CtxPopover.jsx";

const MODE_LABELS = {
  default: "Default",
  acceptEdits: "Accept edits",
  plan: "Plan only",
  bypassPermissions: "Bypass all",
};

const MODEL_LABELS = {
  "haiku-4.5":  { name: "Haiku 4.5",  ctx: "200k" },
  "sonnet-4.5": { name: "Sonnet 4.5", ctx: "200k" },
  "sonnet":     { name: "Sonnet 4.5", ctx: "200k" },
  "opus-4.7":   { name: "Opus 4.7",   ctx: "1M" },
  "opus":       { name: "Opus 4.7",   ctx: "1M" },
};

const EFFORT_LABELS = {
  low: "Low", medium: "Medium", high: "High", extrahigh: "Extra high",
};

export function ComposerControls({ live }) {
  const ui = useUi();
  const draft = ui.drafts.get(ui.selectedId);
  const selected = !draft ? live.workers.find((w) => w.id === ui.selectedId) : null;

  const mode = selected?.permission_mode ?? draft?.permissionMode ?? ui.composer.permissionMode;
  const model = selected?.model ?? draft?.model ?? ui.composer.model;
  const effort = selected?.effort ?? draft?.effort ?? ui.composer.effort;
  const modelInfo = MODEL_LABELS[model] || { name: model || "—", ctx: "" };

  const { used, total, pct } = contextUsage(selected);
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
          <AttachPopover />
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
