// Left rail — the node palette, sourced from the live capability catalog. Each
// entry can be DRAGGED onto the canvas (HTML5 drag → dropped at the cursor's flow
// coordinate) or CLICKED to add at the viewport center. The dragged kind rides the
// dataTransfer as a plain string; FlowCanvas's onDrop resolves it via the catalog.
import { paletteGroups } from "./catalog.js";

export const PALETTE_DND_MIME = "application/x-eos-wf-node";

export function Palette({ catalog, loading, error, onAdd }) {
  return (
    <div className="wfe-palette">
      <div className="wfe-palette__title">Nodes</div>
      <div className="wfe-palette__hint">drag onto canvas, or double-click the canvas to search</div>
      {loading && <div className="wfe-palette__note">Loading catalog…</div>}
      {error && <div className="wfe-palette__note wfe-palette__note--err">{error}</div>}
      {!loading && !error && catalog.kinds.length === 0 && (
        <div className="wfe-palette__note">No node kinds available.</div>
      )}
      {paletteGroups(catalog.kinds).map((group) => (
        <div className="wfe-palette__group" key={group.category}>
          <div className="wfe-palette__group-label">{group.label}</div>
          {group.entries.map((entry) => (
            <button
              type="button"
              key={entry.kind}
              className="wfe-palette__item"
              title={entry.description || entry.kind}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(PALETTE_DND_MIME, entry.kind);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onClick={() => onAdd(entry)}
            >
              <span className="wfe-palette__item-label">{entry.label}</span>
              <span className="wfe-palette__item-kind">{entry.kind}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
