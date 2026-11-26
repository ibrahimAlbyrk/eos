import { fmtTimeAgo } from "../../../lib/format.js";
import { Ring, Section } from "../frame.jsx";
import { openLocation } from "../nav/eosNav.js";
import { itemTone, kindGlyph } from "./words.js";

// How many of the items after this one the foot names.
const SHOWN = 3;

// Under a short item that has no aside: what waits after it, so the answer
// reads as one step through the list and the page does not end in a void.
// `after` is the rest of the pager's order; `nameOf` names a routine.
export function ItemFoot({ after, nameOf, onOpen }) {
  const shown = after.slice(0, SHOWN);
  const more = after.length - shown.length;
  return (
    <Section
      id="eos-needs-then"
      label="Then"
      aside={after.length > 0 ? <><kbd className="eos-needs-foot__key">J</kbd> for the next</> : undefined}
    >
      {shown.length === 0
        ? <p className="eos-needs-foot__none">Nothing else waits for you.</p>
        : (
          <ul className="eos-needs-foot">
            {shown.map((item) => (
              <li key={item.id}>
                <button type="button" className="eos-needs-foot__row" onClick={() => onOpen(item.id)}>
                  <Ring d={kindGlyph(item.kind)} tone={itemTone(item)} />
                  <span className="eos-needs-foot__words">
                    <span className="eos-needs-foot__title">{item.title}</span>
                    <span className="eos-needs-foot__from">{item.kind === "about_you" ? "A guess about you" : nameOf(item.routineId) ?? "Eos"}</span>
                  </span>
                  <span className="eos-needs-foot__time">{fmtTimeAgo(item.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      {more > 0 && (
        <button type="button" className="eos-link eos-needs-foot__all" onClick={() => openLocation("eos:/needs")}>
          {more === 1 ? "One more in Needs you" : `${more} more in Needs you`}
        </button>
      )}
    </Section>
  );
}
