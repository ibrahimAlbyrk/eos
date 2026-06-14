import { useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { usePanePresets } from "../../../hooks/usePanePresets.js";
import { savePreset, removePreset } from "../../../state/panePresetsStore.js";
import { leafCount } from "../../../lib/paneLayout.js";

// Header popover for named split layouts. Trigger + popover mirror the
// HeaderAgentMenu pattern (data-popover-trigger / data-popover so CodeView's
// outside-click handler closes it). Save captures the current panes; clicking a
// preset restores it via PaneProvider.setLayout.
export function PanePresets() {
  const ui = useUi();
  const presets = usePanePresets();
  const [name, setName] = useState("");
  const open = ui.openPopover === "pane-presets";

  const toggle = () => (open ? ui.closeAllPops() : ui.openPop("pane-presets"));

  const save = () => {
    if (!name.trim()) return;
    savePreset(name, ui.tree);
    setName("");
  };

  const apply = (p) => {
    ui.applyStructure(p.tree);
    ui.closeAllPops();
  };

  return (
    <span className="pane-presets-wrap">
      <button
        className="pane-presets-btn"
        data-popover-trigger="pane-presets"
        onClick={toggle}
        title="Saved layouts"
        aria-label="Saved layouts"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 2 2 5l6 3 6-3-6-3z" />
          <path d="M2 8l6 3 6-3M2 11l6 3 6-3" />
        </svg>
      </button>
      {open && (
        <div className="glass-pop pane-presets-pop" data-popover="pane-presets">
          <div className="pp-save">
            <input
              className="pp-input"
              placeholder="Save current layout…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } }}
              autoFocus
            />
            <button className="pp-save-btn" onClick={save} disabled={!name.trim()}>Save</button>
          </div>
          {presets.length === 0 ? (
            <div className="pp-empty">No saved layouts</div>
          ) : (
            <div className="pp-list">
              {presets.map((p) => (
                <div key={p.id} className="pp-item" onClick={() => apply(p)} title={`Restore "${p.name}"`}>
                  <span className="pp-name">{p.name}</span>
                  <span className="pp-count">{leafCount(p.tree)}</span>
                  <button
                    className="pp-del"
                    title="Delete layout"
                    onClick={(e) => { e.stopPropagation(); removePreset(p.id); }}
                  >
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
