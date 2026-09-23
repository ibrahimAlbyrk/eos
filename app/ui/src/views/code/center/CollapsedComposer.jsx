import { useUi } from "../../../state/ui.jsx";
import { contextUsage } from "../../../lib/contextWindow.js";
import { modelName, EFFORT_LABELS } from "../../../lib/models.js";
import { MODE_BY_ID } from "../../../lib/permissionModes.jsx";
import { AttachPopover } from "../popovers/AttachPopover.jsx";
import { SubmitButton } from "./SubmitButton.jsx";

// The composer's collapsed state: while a permission or question card is shown
// the strip + full card hide and the composer shrinks to one pill row — attach
// and send stay live; mode/model/effort/context are a read-only mirror.
export function CollapsedComposer({ worker, hasQuestion, onAttach, submit }) {
  const ui = useUi();
  const selected = worker ?? null;
  const mode = selected?.permission_mode ?? ui.composer.permissionMode;
  const modeMeta = MODE_BY_ID[mode] ?? MODE_BY_ID.acceptEdits;
  const ModeIcon = modeMeta.Icon;
  const model = selected?.model ?? ui.composer.model;
  const effort = selected?.effort ?? ui.composer.effort;

  const { pct } = contextUsage(selected, model);
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
    <div className="composer-compact">
      <div className="cc-attach-wrap" style={{ position: "relative" }}>
        <button className="cc-attach" title="Attach" onClick={(e) => toggle("attach", e)} data-popover-trigger="attach">
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        <AttachPopover onAttach={onAttach} />
      </div>
      <span className="cc-placeholder">{hasQuestion ? "Answer the question…" : "What should we do?"}</span>
      <span className="cc-accept">
        <ModeIcon className={"cc-shield cc-shield--" + mode} />
        {modeMeta.label}
      </span>
      <span className="cc-model">{modelName(model) || model || "—"}</span>
      <span className="cc-effort">{EFFORT_LABELS[effort] ?? "High"}</span>
      <span className="cc-ring">
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <circle className="ring-track" cx="9" cy="9" r="7" />
          {pct > 0 && <circle className="ring-fill" cx="9" cy="9" r="7" strokeDasharray={dashArray} />}
        </svg>
      </span>
      <SubmitButton stop={submit.stop} dim={submit.dim} onClick={submit.onClick} />
    </div>
  );
}
