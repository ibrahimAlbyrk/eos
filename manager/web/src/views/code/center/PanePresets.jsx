import { useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { usePanePresets } from "../../../hooks/usePanePresets.js";
import { savePreset, removePreset, renamePreset, movePreset } from "../../../state/panePresetsStore.js";
import { leafCount } from "../../../lib/paneLayout.js";
import { RenameInput } from "../../../components/RenameInput.jsx";

const PRESET_MIME = "application/x-eos-preset";

// Header popover for named split layouts (structure only). Presets apply on click
// (re-homing current agents), rename on double-click, and reorder by drag — a
// line marks the drop position (no reflow, so no flicker).
export function PanePresets() {
  const ui = useUi();
  const presets = usePanePresets();
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [overId, setOverId] = useState(null);
  const clickTimer = useRef(null);
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

  // Click applies, double-click renames — disambiguated with a short timer so the
  // two clicks of a rename don't apply (and close) the popover first.
  const onItemClick = (p) => {
    clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => apply(p), 220);
  };
  const onItemDouble = (p) => {
    clearTimeout(clickTimer.current);
    setEditingId(p.id);
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
              {presets.map((p) => {
                const editing = editingId === p.id;
                return (
                  <div
                    key={p.id}
                    className={"pp-item" + (overId === p.id ? " pp-over" : "")}
                    title={editing ? undefined : "Click to restore · double-click to rename · drag to reorder"}
                    draggable={!editing}
                    onClick={editing ? undefined : () => onItemClick(p)}
                    onDoubleClick={editing ? undefined : () => onItemDouble(p)}
                    onDragStart={(e) => { e.dataTransfer.setData(PRESET_MIME, p.id); e.dataTransfer.effectAllowed = "move"; }}
                    onDragOver={(e) => {
                      if (!e.dataTransfer.types.includes(PRESET_MIME)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (overId !== p.id) setOverId(p.id);
                    }}
                    onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOverId((o) => (o === p.id ? null : o)); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = e.dataTransfer.getData(PRESET_MIME);
                      if (from) movePreset(from, p.id);
                      setOverId(null);
                    }}
                    onDragEnd={() => setOverId(null)}
                  >
                    {editing ? (
                      <RenameInput
                        currentName={p.name}
                        onSave={(n) => { renamePreset(p.id, n); setEditingId(null); }}
                        onCancel={() => setEditingId(null)}
                      />
                    ) : (
                      <span className="pp-name">{p.name}</span>
                    )}
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
                );
              })}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
