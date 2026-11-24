import { useEffect, useMemo, useRef, useState } from "react";
import { ensureRoutinesLoaded } from "../../../state/eos/routinesStore.js";
import { HomeInput } from "../input/HomeInput.jsx";
import { doorOf, heldThings } from "./held.js";
import { LoginOffer } from "./LoginOffer.jsx";

// The panel's width; its height follows what it shows.
export const WIDTH = 600;

// The quick panel (07 §4.3, RunOutside.dc.html): the Home input folded small
// over whatever app is in front, holding what a door brought (the selection,
// a Services or share item, a Dock drop, an `eos://send` link). Run, the live
// line and a one-off's result show under it as at Home. Escape closes it;
// the shell closes it too when the user goes back to another app.
export function QuickPanel({ doors = globalThis.window?.eosDoors }) {
  const [item, setItem] = useState(null);
  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const held = useMemo(() => heldThings(item), [item]);

  useEffect(() => { void ensureRoutinesLoaded(); }, []);
  useEffect(() => {
    if (!doors) return undefined;
    doors.held().then(setItem, () => {});
    // A new item replaces the one shown; `null` when the panel closed.
    return doors.onHeld(setItem);
  }, [doors]);
  useEffect(() => { inputRef.current?.focus(); }, [item]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) doors?.closePanel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doors]);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !doors || typeof ResizeObserver === "undefined") return undefined;
    const fit = new ResizeObserver(() => doors.sizePanel(WIDTH, Math.ceil(el.getBoundingClientRect().height)));
    fit.observe(el);
    return () => fit.disconnect();
  }, [doors]);

  return (
    <div ref={rootRef} className="eos-quick" style={{ width: WIDTH }}>
      <HomeInput held={held} door={doorOf(item)} inputRef={inputRef} />
      <LoginOffer doors={doors} />
    </div>
  );
}
