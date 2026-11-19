import { RUNGS } from "./FreedomLadder.jsx";
import { changedSlots, slotText, SLOTS } from "./slots/index.js";

const FREEDOM = { key: "freedom", label: "Freedom" };

function said(slot, bp, routines) {
  if (slot.key === "freedom") return RUNGS.find((r) => r.value === bp?.freedom?.rung)?.label ?? "Not set";
  return slotText(slot, bp, { routines }) || "Not set";
}

// "Compare with current": each slot that differs, as this version says it
// and as the version in use says it.
export function VersionCompare({ version, current, routines }) {
  const changed = changedSlots(version, current);
  if (changed.length === 0) return <p className="eos-note">The same as the version in use.</p>;
  return (
    <table className="eos-bp-compare">
      <thead><tr><th scope="col">Slot</th><th scope="col">This version</th><th scope="col">In use</th></tr></thead>
      <tbody>
        {[...SLOTS, FREEDOM].filter((s) => changed.includes(s.key)).map((slot) => (
          <tr key={slot.key}>
            <th scope="row">{slot.label}</th>
            <td>{said(slot, version, routines)}</td>
            <td>{said(slot, current, routines)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
