import { useState } from "react";
import { notify } from "../../../lib/notify.js";
import { PIN_SLOTS, pin, replacePin, unpin, usePins } from "../../../state/eos/pinsStore.js";

// Pin to Home, or Pinned (unpins). Home holds three: pinning a fourth opens
// "Unpin one first", listing the three, each to replace.
export function PinButton({ surface }) {
  const { ids, tiles } = usePins();
  const [replacing, setReplacing] = useState(false);
  if (ids === null) return null;
  const pinned = ids.includes(surface.id);
  const toggle = async () => {
    const r = pinned ? await unpin(surface.id) : await pin(surface.id);
    if (r.full) setReplacing(true);
    else if (!r.ok) notify.error(r.error, { title: "Pinning did not work" });
  };
  const replace = async (out) => {
    setReplacing(false);
    const r = await replacePin(out, surface.id);
    if (!r.ok) notify.error(r.error ?? "Home is full.", { title: "Pinning did not work" });
  };
  const titleOf = (id) => tiles?.find((t) => t.surfaceId === id)?.title ?? "A pinned page";
  return (
    <span className="eos-menu-wrap">
      <button type="button" className="eos-btn eos-btn--quiet" aria-pressed={pinned} onClick={() => void toggle()}>
        {pinned ? "Pinned to Home" : "Pin to Home"}
      </button>
      {replacing && (
        <div className="eos-menu eos-pin-full" role="dialog" aria-label="Unpin one first" onKeyDown={(e) => { if (e.key === "Escape") setReplacing(false); }}>
          <p className="eos-pin-full__title">Unpin one first</p>
          <p className="eos-pin-full__line">Home holds {PIN_SLOTS} pins. Pick the one this page replaces.</p>
          {ids.map((id) => (
            <button key={id} type="button" className="eos-menu__item" onClick={() => void replace(id)}>Replace {titleOf(id)}</button>
          ))}
          <button type="button" className="eos-menu__item eos-menu__item--more" onClick={() => setReplacing(false)}>Cancel</button>
        </div>
      )}
    </span>
  );
}
