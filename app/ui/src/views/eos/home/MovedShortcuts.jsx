import { shortcutLabel } from "../../../lib/platform.js";
import { dismissShortcutsMoved, useShortcutsMovedPending } from "../../../state/eos/movedShortcuts.js";

// Told once to a user whose mode shortcuts moved when Eos became first (D2).
export function MovedShortcuts() {
  if (!useShortcutsMovedPending()) return null;
  const key = (n) => shortcutLabel(`mod+ctrl+${n}`);
  return (
    <div className="eos-band eos-home__moved" role="status">
      <span className="eos-band__text">
        Eos is first now, at {key(1)}. Agents moved to {key(2)}, Code to {key(3)} and Machines to {key(4)}.
      </span>
      <button type="button" className="eos-btn eos-btn--quiet" onClick={dismissShortcutsMoved}>Got it</button>
    </div>
  );
}
