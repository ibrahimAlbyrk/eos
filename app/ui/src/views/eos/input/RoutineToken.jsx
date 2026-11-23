import { chipLabel } from "../runform/runFormModel.js";

// The routine picked, as a token before the item slot (RunInput.dc.html),
// then the items chosen for it, each removable.
export function RoutineToken({ routine, items, onRemove, onRemoveItem }) {
  return (
    <>
      <span className="eos-token">
        {routine.name}
        <button type="button" className="eos-token__remove" aria-label={`Remove ${routine.name}`} onClick={onRemove}>
          <svg aria-hidden="true" width="10" height="10" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </span>
      {items.map((item, i) => (
        <span key={item.key ?? i} className="eos-thing" title={item.title ?? undefined}>
          <span className="eos-thing__label">{chipLabel(item)}</span>
          <button type="button" className="eos-thing__remove" aria-label={`Remove ${chipLabel(item)}`} onClick={() => onRemoveItem(item)}>×</button>
        </span>
      ))}
    </>
  );
}
