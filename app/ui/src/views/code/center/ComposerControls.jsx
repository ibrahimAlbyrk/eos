import { useUi } from "../../../state/ui.jsx";
import { contextUsage } from "../../../lib/contextWindow.js";
import { modelName, modelCtx, EFFORT_LABELS, effortChoicesFor } from "../../../lib/models.js";
import { AcceptPopover } from "../popovers/AcceptPopover.jsx";
import { AttachPopover } from "../popovers/AttachPopover.jsx";
import { ModelPopover } from "../popovers/ModelPopover.jsx";
import { BackendPopover, SpawnModelPopover } from "../popovers/BackendPopover.jsx";
import { EffortPopover } from "../popovers/EffortPopover.jsx";
import { CtxPopover } from "../popovers/CtxPopover.jsx";
import { GitAgentPopover } from "../popovers/GitAgentPopover.jsx";
import { TemplatePickerPopover } from "../popovers/TemplatePickerPopover.jsx";
import { MODE_BY_ID } from "../../../lib/permissionModes.jsx";
import { backendCaps, providerChoices, providerName, runningProviderLabel } from "../../../lib/backendCaps.js";
import { parseWorkerTasks } from "../../../lib/workerTasks.js";

export function ComposerControls({ live, onAttach, historyNav, demoted, wtStatus }) {
  const ui = useUi();
  const selected = live.workers.find((w) => w.id === ui.selectedId) ?? null;

  // Compact mirror of the ambient status (tasks + worktree fleet) shown only
  // while a blocking banner has demoted those panels out of the band above.
  const tasks = selected ? parseWorkerTasks(selected) : [];
  const taskTotal = tasks.length;
  const taskDone = tasks.filter((t) => t.status === "completed").length;
  const wtCount = wtStatus?.count ?? 0;
  const showAmbientMini = demoted && (taskTotal > 0 || wtCount > 0);

  const mode = selected?.permission_mode ?? ui.composer.permissionMode;
  const modeMeta = MODE_BY_ID[mode] ?? MODE_BY_ID.acceptEdits;
  const ModeIcon = modeMeta.Icon;
  // A new-spawn provider pick runs the operator-chosen model: picking the provider
  // defaults composer.model to a profile's pinned model, and the model pill then
  // refines it from the provider's own model list.
  const spawnChoice = !selected ? (providerChoices().find((p) => p.name === ui.composer.provider) ?? null) : null;
  const spawnIsApi = !!spawnChoice && !spawnChoice.subscription;
  const model = selected?.model ?? ui.composer.model;
  const effort = selected?.effort ?? ui.composer.effort;
  const modelInfo = { name: modelName(model) || model || "—", ctx: modelCtx(model) || "" };
  // Lock the runtime model switch only for a selected structured worker; the
  // new-spawn model is chosen via the model picker, never disabled.
  const modelLocked = !!selected && !backendCaps(selected.backend_kind).runtimeModelSwitch;
  // The model pill opens the provider's own model list for an API-profile spawn
  // (its models aren't the Claude catalog), else the Claude model popover.
  const modelPopId = spawnIsApi ? "spawnModel" : "model";

  // Provider switcher: only for a selected worker, and only when there's another
  // CONFIGURED provider to switch to (the same providerChoices the menu lists, so
  // the pill never opens onto a single, un-switchable entry). The daemon stops +
  // resumes under the new backend (keeping the conversation) and rejects a busy
  // worker — so gate the pill on an at-rest state to keep that rejection off the
  // happy path.
  const showProvider = !!selected && providerChoices().length > 1;
  const providerBusy = !!selected && !["IDLE", "SUSPENDED", "DONE"].includes(selected.state);

  // New-spawn provider picker: the unified provider list (subscription kinds +
  // configured API profiles). Picking one sets composer.provider + a model.
  const showSpawnProvider = !selected && providerChoices().length > 0;
  const spawnProviderLabel = providerName(spawnChoice) ?? ui.composer.provider ?? "Provider";

  const { used, total, pct } = contextUsage(selected, model);
  const r = 7;
  const C = 2 * Math.PI * r;
  const filled = (pct / 100) * C;
  const dashArray = `${filled.toFixed(2)} ${(C - filled).toFixed(2)}`;
  const warn = Math.max(0, Math.min(1, (pct - 50) / 30));
  // oklch keeps chroma while the hue rotates blue→teal→green→yellow; srgb
  // mixing of complementary blue+yellow washes out to gray in the middle.
  const ringColor = `color-mix(in oklch, var(--accent), #f0b429 ${Math.round(warn * 100)}%)`;

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
            <ModeIcon className="mode-ic" />
            <span className="mode-label">{modeMeta.label}</span>
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
        <div className="mem-wrap" style={{ position: "relative" }}>
          <button
            className="iconbtn"
            title={ui.selectedId ? "Project memory" : "Select an agent to view its project memory"}
            disabled={!ui.selectedId}
            onClick={() => { if (ui.selectedId) ui.openMemoryViewer(ui.selectedId); }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="8" cy="4" rx="5" ry="2" />
              <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
              <path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
            </svg>
          </button>
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
        {showProvider && (
          <div className="provider-wrap" style={{ position: "relative" }}>
            <button
              className={"model-pill" + (ui.openPopover === "backend" ? " open" : "")}
              disabled={providerBusy}
              title={providerBusy ? "Provider switch needs the worker idle" : "Switch provider — keeps the conversation"}
              onClick={(e) => toggle("backend", e)}
              data-popover-trigger="backend"
            >
              <span>{runningProviderLabel(selected)}</span>
            </button>
            <BackendPopover live={live} />
          </div>
        )}
        {showSpawnProvider && (
          <div className="provider-wrap" style={{ position: "relative" }}>
            <button
              className={"model-pill" + (ui.openPopover === "backend" ? " open" : "")}
              title="Provider + model for the next agent"
              onClick={(e) => toggle("backend", e)}
              data-popover-trigger="backend"
            >
              <span>{spawnProviderLabel}</span>
            </button>
            <BackendPopover live={live} />
          </div>
        )}
        <div className="model-wrap" style={{ position: "relative" }}>
          <button
            className={"model-pill" + (ui.openPopover === modelPopId ? " open" : "")}
            id="modelPill"
            disabled={modelLocked}
            title={!selected ? "Model for this provider" : (modelLocked ? "Model is fixed for this backend (set at spawn)" : undefined)}
            onClick={(e) => toggle(modelPopId, e)}
            data-popover-trigger={modelPopId}
          >
            <span>{modelInfo.name}</span>
            {modelInfo.ctx && <span className="ctx">({modelInfo.ctx} context)</span>}
          </button>
          <ModelPopover live={live} />
          <SpawnModelPopover />
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
            className={"ctx-ring-btn" + (ui.openPopover === "ctx" ? " open" : "")}
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
            backendKind={selected?.backend_kind}
          />
        </div>
        {showAmbientMini && (
          <div className="ambient-mini" title="Tasks and worktree changes — shown above once no prompt is pending">
            {taskTotal > 0 && (
              <span className="am-chip" title={`${taskDone}/${taskTotal} tasks done`}>
                <AmbientRing pct={taskTotal ? taskDone / taskTotal : 0} />
                <span>{taskDone}/{taskTotal}</span>
              </span>
            )}
            {wtCount > 0 && (
              <span className="am-chip" title={`${wtCount} worktree${wtCount === 1 ? "" : "s"} with changes`}>
                <WorktreeGlyph />
                <span>{wtCount}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AmbientRing({ pct }) {
  const r = 6;
  const C = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, pct)) * C;
  return (
    <svg className="am-ring" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" stroke="rgba(var(--tint), 0.18)" strokeWidth="1.8" />
      {pct > 0 && (
        <circle
          cx="8" cy="8" r={r}
          fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
          strokeDasharray={`${filled.toFixed(2)} ${(C - filled).toFixed(2)}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  );
}

function WorktreeGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 8h5M8 5.5v5" />
    </svg>
  );
}
