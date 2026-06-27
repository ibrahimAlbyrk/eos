// Left rail — the node palette, sourced from the live capability catalog. Each
// entry adds a node of that kind (with its default typed ports) to the canvas.
import { paletteGroups } from "./catalog.js";

export function Palette({ catalog, loading, error, onAdd }) {
  return (
    <div className="wfe-palette">
      <div className="wfe-palette__title">Nodes</div>
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
