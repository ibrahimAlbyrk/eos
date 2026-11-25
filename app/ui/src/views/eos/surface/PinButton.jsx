import { useState } from "react";
import { notify } from "../../../lib/notify.js";
import { PIN_SLOTS, pin, replacePin, unpin, usePins } from "../../../state/eos/pinsStore.js";
import { AskPick, Dialog } from "../frame.jsx";
import { numberWord } from "../home/homeWords.js";

const PIN_ICON = "M6 2.5h4M7 2.5v4L4.5 9h7L9 6.5v-4M8 9v4.5";

// Pin to Home, or Pinned (unpins). Home holds three: pinning a fourth asks in
// Eos's dialog which pinned page this one replaces, each named with its
// headline, Cancel first and Replace once one is picked.
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
  return (
    <>
      <button type="button" className="eos-btn eos-btn--quiet" aria-pressed={pinned} onClick={() => void toggle()}>
        {pinned ? "Pinned to Home" : "Pin to Home"}
      </button>
      {replacing && <ReplacePin surface={surface} ids={ids} tiles={tiles} onClose={() => setReplacing(false)} />}
    </>
  );
}

// The tile a pinned page shows on Home, as a pick: its title, its headline,
// and what kind of thing it is.
export const pickOf = (id, tiles) => {
  const tile = tiles?.find((t) => t.surfaceId === id);
  return { id, name: tile?.title ?? "A pinned page", line: tile?.headline, kind: tile?.level === "view" ? "View" : "Page" };
};

export function ReplacePin({ surface, ids, tiles, onClose, initial = null }) {
  const [out, setOut] = useState(initial);
  const replace = async () => {
    onClose();
    const r = await replacePin(out, surface.id);
    if (!r.ok) notify.error(r.error ?? "Home is full.", { title: "Pinning did not work" });
  };
  return (
    <Dialog
      id="eos-pin-full"
      from="Pin to Home"
      icon={PIN_ICON}
      title={`Which page does ${surface.title ?? "this page"} replace?`}
      line={`Home holds ${numberWord(PIN_SLOTS)} pages, and all ${numberWord(PIN_SLOTS)} are pinned. The one you pick leaves Home and stays with its routine.`}
      onClose={onClose}
      actions={(
        <>
          <button type="button" className="eos-btn eos-btn--quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="eos-btn eos-btn--primary" disabled={out === null} onClick={() => void replace()}>Replace</button>
        </>
      )}
    >
      <AskPick label="Pinned to Home" items={ids.map((id) => pickOf(id, tiles))} picked={out} onPick={setOut} />
    </Dialog>
  );
}
